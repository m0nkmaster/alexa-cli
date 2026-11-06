import { getConfig, type Domain } from "./config.js";
import { authenticate, type AlexaCredentials } from "./auth.js";
import {
  clearSmartHomeCache,
  DEVICES_CACHE_TTL_MS,
  readAppliancesCache,
  writeAppliancesCache,
} from "./devices-cache.js";
import { fetch } from "undici";
import {
  AmbiguousMatchError,
  controlResultFlags,
  resolveUniqueMatch,
} from "./match.js";

export { AmbiguousMatchError } from "./match.js";

export interface Device {
  accountName: string;
  serialNumber: string;
  deviceType: string;
  deviceFamily: string;
  deviceOwnerCustomerId: string;
  online: boolean;
  capabilities?: string[];
}

export interface Appliance {
  entityId: string;
  /** GraphQL endpoint ID (amzn1.alexa.endpoint.*) when available from layout; used for eu-api control */
  endpointId?: string;
  applianceId?: string;
  friendlyName: string;
  friendlyDescription?: string;
  applianceTypes?: string[];
  isReachable: boolean;
  /** Amazon customer ID of the account that owns this device (for profile matching) */
  deviceOwnerCustomerId?: string;
  /** Alexa interface capabilities (e.g., Alexa.BrightnessController, Alexa.ColorTemperatureController) */
  capabilities?: string[];
}

export interface Routine {
  automationId: string;
  name: string;
  sequence: unknown;
  status?: string;
  type?: string;
}

export interface DeviceGroup {
  name: string;
  groupId: string;
  type: string;
  applianceCount: number;
}

export interface DeviceGroupWithAppliances extends DeviceGroup {
  /** Chr entity IDs (UUIDs) for direct control; use as amzn1.alexa.endpoint.{id} for GraphQL. */
  chrEntityIds: string[];
}

export interface GroupMembersResult {
  group: string;
  groupId: string;
  members: Appliance[];
  /** Stale group endpoint IDs that no longer resolve to a known appliance. */
  unresolved: string[];
}

export interface ControlTarget {
  name: string;
  endpointId: string;
  resolved: boolean;
}

export interface GroupControlResult {
  controlled: string[];
  errors: string[];
  unresolved: string[];
  success: boolean;
  partial: boolean;
  /** Present when dryRun: planned targets without controlling. */
  planned?: ControlTarget[];
}

export interface RenameResult {
  endpointId: string;
  oldName: string;
  newName: string;
  dryRun: boolean;
}

export interface AudioGroup {
  id: string;
  name: string;
  members: Array<{ deviceType: string; dsn: string; speakerChannel: string }>;
}

export interface ClientOptions {
  refreshToken: string;
  domain?: Domain;
}

export class AlexaClient {
  private creds: AlexaCredentials | null = null;
  private readonly refreshToken: string;
  private readonly domain: Domain;
  private appliancesCache: { appliances: Appliance[]; expiresAt: number } | null = null;

  constructor(options: ClientOptions) {
    this.refreshToken = options.refreshToken;
    this.domain = options.domain ?? "amazon.co.uk";
  }

  private async ensureAuth(): Promise<AlexaCredentials> {
    if (this.creds) return this.creds;
    this.creds = await authenticate({
      refreshToken: this.refreshToken,
      domain: this.domain,
    });
    return this.creds;
  }

  /** Low-level app API request (eu-api / na-api). */
  private async request<T = unknown>(opts: {
    method: "GET" | "POST" | "PUT";
    url: string;
    body?: unknown;
    throwOnError: boolean;
    errorPrefix?: string;
    extraHeaders?: Record<string, string>;
  }): Promise<T> {
    const config = getConfig(this.domain);
    const creds = await this.ensureAuth();
    const fullUrl = `${config.appApiBase.replace(/\/$/, "")}${opts.url.startsWith("/") ? opts.url : "/" + opts.url}`;
    const headers: Record<string, string> = {
      Cookie: creds.cookies,
      csrf: creds.csrf,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...opts.extraHeaders,
    };
    const init: RequestInit = {
      method: opts.method,
      headers,
    };
    if (opts.body !== undefined && opts.method !== "GET") {
      init.body = JSON.stringify(opts.body);
    }
    const res = await fetch(fullUrl, init as import("undici").RequestInit);
    const text = await res.text();
    if (process.env.ALEXA_DEBUG) {
      const bodyPreview = text.slice(0, 500);
      console.error(`[alexa-cli] ${opts.method} ${fullUrl} → ${res.status} (${text.length}b): ${bodyPreview}`);
    }
    if (!res.ok) {
      if (opts.throwOnError) {
        const prefix = opts.errorPrefix ?? "API error ";
        throw new Error(`${prefix}${res.status}: ${text.slice(0, 200)}`);
      }
      return {} as T;
    }
    if (!text.trim()) return {} as T;
    try {
      return JSON.parse(text) as T;
    } catch {
      return {} as T;
    }
  }

  /** GET from app API. Returns {} on failure (non-throwing). */
  private async getFromAppApi(url: string): Promise<unknown> {
    return this.request({ method: "GET", url, throwOnError: false });
  }

  /** GET app endpoint. Throws on failure. */
  private async getApp(url: string): Promise<unknown> {
    return this.request({ method: "GET", url, throwOnError: true });
  }

  /** POST app endpoint. Throws on failure. */
  private async postApp(url: string, body: unknown): Promise<unknown> {
    return this.request({ method: "POST", url, body, throwOnError: true });
  }

  /** PUT app endpoint. Throws on failure. */
  private async putApp(url: string, body: unknown): Promise<unknown> {
    return this.request({ method: "PUT", url, body, throwOnError: true });
  }

  /** POST to app API (e.g. control-media-session). Throws on failure. */
  private async postFromAppApi(url: string, body: unknown): Promise<{ ok: boolean; data?: unknown }> {
    const data = await this.request<unknown>({
      method: "POST",
      url,
      body,
      throwOnError: true,
      errorPrefix: "Media API error ",
    });
    return { ok: true, data };
  }

  /**
   * GET /api/smarthome/v1/presentation/devices/control — layout IDs to capabilities.
   * Returns layout keys (endpoint IDs like amzn1.alexa.endpoint.*) when available.
   */
  private async fetchLayouts(): Promise<string[]> {
    try {
      const data = (await this.getFromAppApi(
        "/api/smarthome/v1/presentation/devices/control"
      )) as { layouts?: Record<string, unknown> };
      const layouts = data?.layouts;
      if (layouts && typeof layouts === "object") {
        return Object.keys(layouts);
      }
    } catch {
      // ignore
    }
    return [];
  }

  /** GraphQL fragment used by the Alexa app to query endpoint features/capabilities. */
  private static readonly ENDPOINT_FEATURES_QUERY = `query EndpointFeaturesQuery($endpointId: String!) {
  endpoint(id: $endpointId) {
    id
    enablement
    features {
      name
      properties {
        __typename
        name
        type
        accuracy
        ... on Brightness { brightnessStateValue }
        ... on ColorTemperature { colorTemperatureInKelvinStateValue }
        ... on Power { powerStateValue }
        ... on Reachability { reachabilityStatusValue }
      }
      __typename
      name
      instance
    }
    __typename
  }
}`;

  /**
   * Fetch capabilities for a set of endpoint IDs using batched GraphQL endpoint() queries.
   * Returns a map of endpoint ID to array of feature names (e.g. "brightness", "colorTemperature", "power").
   */
  private async fetchEndpointCapabilities(endpointIds: string[]): Promise<Map<string, string[]>> {
    const capabilitiesMap = new Map<string, string[]>();
    if (endpointIds.length === 0) return capabilitiesMap;

    try {
      const batch = endpointIds.map((endpointId) => ({
        operationName: "EndpointFeaturesQuery",
        variables: { endpointId },
        query: AlexaClient.ENDPOINT_FEATURES_QUERY,
      }));

      const results = await this.postGraphqlBatch(batch);

      for (const result of results) {
        const r = result as { data?: { endpoint?: { id?: string; features?: Array<{ name?: string }> } } };
        const endpoint = r?.data?.endpoint;
        if (!endpoint?.id || !endpoint.features) continue;
        const features = endpoint.features
          .map((f) => f.name)
          .filter((n): n is string => !!n && n !== "endpointHealth" && n !== "connectivity");
        if (features.length > 0) {
          capabilitiesMap.set(endpoint.id, features);
        }
      }
    } catch {
      // ignore — capabilities are best-effort
    }
    return capabilitiesMap;
  }

  /**
   * POST /nexus/v1/graphql (eu-api) — power/brightness control. Uses endpointId (amzn1.alexa.endpoint.*).
   * Uses setEndpointFeatures mutation (matches Alexa mobile app); updatePowerFeatureForEndpoints can fail silently.
   */
  private async graphqlControl(
    endpointId: string,
    action: "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature",
    brightness?: number,
    colorTemperatureInKelvin?: number
  ): Promise<void> {
    if (action === "setBrightness") {
      if (brightness === undefined) throw new Error("brightness required for setBrightness");
      const result = (await this.postGraphql({
        operationName: "setBrightness",
        variables: {
          endpointId,
          value: brightness,
        },
        query: `mutation setBrightness($endpointId: String, $value: Int) {
  setEndpointFeatures(
    setEndpointFeaturesInput: {featureControlRequests: [{endpointId: $endpointId, featureName: brightness, featureOperationName: setBrightness, payload: {brightness: $value}}]}
  ) {
    featureControlResponses {
      code
      endpointId
      featureOperationName
      __typename
    }
    errors {
      code
      message
      featureOperationName
      __typename
    }
    __typename
  }
}`,
      })) as { data?: { setEndpointFeatures?: { errors?: Array<{ code: string; message: string }> } }; errors?: Array<{ message: string }> };
      this.throwOnGraphqlErrors(result);
      return;
    }
    if (action === "setColorTemperature") {
      if (colorTemperatureInKelvin === undefined) throw new Error("colorTemperatureInKelvin required for setColorTemperature");
      const result = (await this.postGraphql({
        operationName: "setColorTemperature",
        variables: {
          endpointId,
          colorTemperatureInKelvin,
        },
        query: `mutation setColorTemperature($endpointId: String!, $colorTemperatureInKelvin: Int!) {
  setEndpointFeatures(setEndpointFeaturesInput: {
    featureControlRequests: [{
      endpointId: $endpointId,
      featureName: colorTemperature,
      featureOperationName: setColorTemperature,
      payload: { colorTemperatureInKelvin: $colorTemperatureInKelvin }
    }]
  }) {
    featureControlResponses { 
      code 
      endpointId 
      featureOperationName 
      __typename 
    }
    errors { 
      code 
      message 
      featureOperationName 
      __typename 
    }
    __typename
  }
}`,
      })) as { data?: { setEndpointFeatures?: { errors?: Array<{ code: string; message: string }> } }; errors?: Array<{ message: string }> };
      this.throwOnGraphqlErrors(result);
      return;
    }
    const featureOp = action === "turnOn" ? "turnOn" : "turnOff";
    const result = (await this.postGraphql({
      operationName: "setPower",
      variables: {
        endpointId,
        featureOperationName: featureOp,
      },
      query:
        "mutation setPower($endpointId: String, $featureOperationName: FeatureOperationName!) { setEndpointFeatures(setEndpointFeaturesInput: {featureControlRequests: [{endpointId: $endpointId, featureName: power, featureOperationName: $featureOperationName}]}) { featureControlResponses { code endpointId featureOperationName __typename } errors { code message featureOperationName __typename } __typename } }",
    })) as {
      data?: {
        setEndpointFeatures?: {
          featureControlResponses?: Array<{ code: string; endpointId: string }>;
          errors?: Array<{ code: string; message: string }>;
        };
      };
      errors?: Array<{ message: string }>;
    };
    const gqlErrors = result?.errors;
    const mutationErrors = result?.data?.setEndpointFeatures?.errors;
    const responses = result?.data?.setEndpointFeatures?.featureControlResponses;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error: ${gqlErrors.map(e => e.message).join("; ")}`);
    }
    if (mutationErrors?.length) {
      throw new Error(`Control error: ${mutationErrors.map(e => `${e.code}: ${e.message}`).join("; ")}`);
    }
    if (responses?.length && responses.some(r => r.code !== "SUCCESS")) {
      const failed = responses.filter(r => r.code !== "SUCCESS");
      throw new Error(`Control failed: ${failed.map(r => `${r.endpointId}: ${r.code}`).join("; ")}`);
    }
  }

  /**
   * Batch POST /nexus/v1/graphql — control multiple endpoints at once.
   * Uses setEndpointFeatures mutation with multiple featureControlRequests.
   * Much faster than individual requests for many devices.
   * Returns featureControlResponses array with per-endpoint {endpointId, code} so callers can
   * report per-device success/failure.
   */
  private async graphqlBatchControl(
    requests: Array<{
      endpointId: string;
      action: "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature";
      brightness?: number;
      colorTemperatureInKelvin?: number;
    }>
  ): Promise<Array<{ endpointId: string; code: string }>> {
    if (requests.length === 0) return [];

    // Build inline GraphQL array syntax like the working single mutations
    const requestsGraphQL = requests.map((req) => {
      if (req.action === "turnOn" || req.action === "turnOff") {
        return `{endpointId: "${req.endpointId}", featureName: power, featureOperationName: ${req.action}}`;
      } else if (req.action === "setBrightness") {
        if (req.brightness === undefined) throw new Error("brightness required for setBrightness");
        return `{endpointId: "${req.endpointId}", featureName: brightness, featureOperationName: setBrightness, payload: {brightness: ${req.brightness}}}`;
      } else if (req.action === "setColorTemperature") {
        if (req.colorTemperatureInKelvin === undefined) throw new Error("colorTemperatureInKelvin required for setColorTemperature");
        return `{endpointId: "${req.endpointId}", featureName: colorTemperature, featureOperationName: setColorTemperature, payload: {colorTemperatureInKelvin: ${req.colorTemperatureInKelvin}}}`;
      } else {
        throw new Error(`Unsupported action: ${req.action}`);
      }
    }).join(', ');

    const result = (await this.postGraphql({
      operationName: "batchSetEndpointFeatures",
      variables: {},
      query: `mutation batchSetEndpointFeatures {
  setEndpointFeatures(setEndpointFeaturesInput: {
    featureControlRequests: [${requestsGraphQL}]
  }) {
    featureControlResponses { 
      code 
      endpointId 
      featureOperationName 
      __typename 
    }
    errors { 
      code 
      message 
      featureOperationName 
      __typename 
    }
    __typename
  }
}`,
    })) as {
      data?: {
        setEndpointFeatures?: {
          featureControlResponses?: Array<{ code: string; endpointId: string; featureOperationName: string }>;
        };
      };
    };
    return result?.data?.setEndpointFeatures?.featureControlResponses ?? [];
  }

  /** POST to nexus/v1/graphql with app-like headers (matches Alexa mobile app). */
  private async postGraphql(body: { operationName: string; variables: Record<string, unknown>; query: string }): Promise<unknown> {
    return this.request({
      method: "POST",
      url: "/nexus/v1/graphql",
      body,
      throwOnError: true,
      errorPrefix: "GraphQL ",
      extraHeaders: this.graphqlHeaders(),
    });
  }

  /** Batch GraphQL requests (array of operations); used for fetching friendly names. */
  private async postGraphqlBatch(
    bodies: Array<{ operationName: string; variables: Record<string, unknown>; query: string }>
  ): Promise<unknown[]> {
    if (bodies.length === 0) return [];
    const result = await this.request<unknown[]>({
      method: "POST",
      url: "/nexus/v1/graphql",
      body: bodies,
      throwOnError: true,
      errorPrefix: "GraphQL batch ",
      extraHeaders: this.graphqlHeaders(),
    });
    return Array.isArray(result) ? result : [];
  }

  /** Throw if a GraphQL mutation response contains errors. */
  private throwOnGraphqlErrors(result: {
    data?: { setEndpointFeatures?: { featureControlResponses?: Array<{ code: string; endpointId: string }>; errors?: Array<{ code: string; message: string }> } };
    errors?: Array<{ message: string }>;
  }): void {
    const gqlErrors = result?.errors;
    const mutationErrors = result?.data?.setEndpointFeatures?.errors;
    const responses = result?.data?.setEndpointFeatures?.featureControlResponses;
    if (gqlErrors?.length) {
      throw new Error(`GraphQL error: ${gqlErrors.map(e => e.message).join("; ")}`);
    }
    if (mutationErrors?.length) {
      throw new Error(`Control error: ${mutationErrors.map(e => `${e.code}: ${e.message}`).join("; ")}`);
    }
    if (responses?.length && responses.some(r => r.code !== "SUCCESS")) {
      const failed = responses.filter(r => r.code !== "SUCCESS");
      throw new Error(`Control failed: ${failed.map(r => `${r.endpointId}: ${r.code}`).join("; ")}`);
    }
  }

  private graphqlHeaders(): Record<string, string> {
    return {
      "x-amzn-client": "AlexaApp",
      "x-amzn-build-version": "2.2.706594",
      "x-amzn-os-name": "ios",
      "x-amzn-devicetype": "phone",
      "x-amzn-devicetype-id": "A2IVLV5VM2W81",
      "x-amzn-marketplace-id": "A1F83G8C2ARO7P",
      "User-Agent": "Alexa/2.2.706594 CFNetwork/3860.500.111 Darwin/25.4.0",
      Accept: "*/*",
    };
  }

  /** GraphQL ControlPageBanner query returns friendlyNameObject.value.text. */
  private static readonly FRIENDLY_NAME_QUERY = `query ControlPageBanner($endpointId: String!) {
    endpoint(id: $endpointId) {
      id
      friendlyNameObject { value { text __typename } __typename }
      __typename
    }
  }`;

  /** Batch-fetch friendly names for endpoint IDs. Returns map endpointId -> friendlyName. */
  private async fetchFriendlyNames(endpointIds: string[]): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    const amzn = endpointIds.filter((id) => id.startsWith("amzn1."));
    if (amzn.length === 0) return map;
    const bodies = amzn.map((endpointId) => ({
      operationName: "ControlPageBanner",
      variables: { endpointId },
      query: AlexaClient.FRIENDLY_NAME_QUERY,
    }));
    const results = await this.postGraphqlBatch(bodies);
    for (const result of results) {
      const r = result as { data?: { endpoint?: { id?: string; friendlyNameObject?: { value?: { text?: string } } } } } | undefined;
      const id = r?.data?.endpoint?.id;
      const text = r?.data?.endpoint?.friendlyNameObject?.value?.text;
      if (id && text) map.set(id, text);
    }
    return map;
  }

  /**
   * POST /api/smarthome/v2/endpoints — used by the Alexa app for device list.
   * Returns endpoints array; names may be encrypted (we use serialNumber as display when missing).
   */
  private async fetchSmarthomeV2Endpoints(): Promise<{ data: unknown; status: number }> {
    const config = getConfig(this.domain);
    const creds = await this.ensureAuth();
    const url = `${config.appApiBase.replace(/\/$/, "")}/api/smarthome/v2/endpoints`;
    const res = await fetch(url, {
      method: "POST",
      headers: {
        Cookie: creds.cookies,
        csrf: creds.csrf,
        "Content-Type": "application/json; charset=utf-8",
        Accept: "application/json; charset=utf-8",
        "Accept-Language": config.locale + "," + config.locale + ";q=1.0",
        "User-Agent": "AppleWebKit PitanguiBridge/2.2.706594.0 (iPhone; iOS)",
      },
      body: JSON.stringify({ endpointContexts: ["GROUP"] }),
    });
    const text = await res.text();
    if (process.env.ALEXA_DEBUG) {
      console.error(`[alexa-cli] POST ${url} → ${res.status} (body length ${text.length})`);
    }
    if (!res.ok) {
      return { data: {}, status: res.status };
    }
    if (!text.trim()) {
      return { data: {}, status: res.status };
    }
    try {
      return { data: JSON.parse(text) as unknown, status: res.status };
    } catch {
      return { data: {}, status: res.status };
    }
  }

  async getDevices(): Promise<Device[]> {
    const data = (await this.getFromAppApi("/api/devices-v2/device?cached=true")) as { devices?: Device[] };
    const devices = data?.devices ?? [];
    return devices.map((d) => ({
      accountName: d.accountName,
      serialNumber: d.serialNumber,
      deviceType: d.deviceType,
      deviceFamily: d.deviceFamily,
      deviceOwnerCustomerId: d.deviceOwnerCustomerId,
      online: d.online,
    }));
  }

  async resolveDevice(deviceQuery: string): Promise<Device | null> {
    const devices = await this.getDevices();
    const bySerial = devices.find((d) => d.serialNumber === deviceQuery);
    if (bySerial) return bySerial;
    return resolveUniqueMatch(devices, deviceQuery, (d) => d.accountName);
  }

  async speak(
    deviceSerial: string,
    deviceType: string,
    customerId: string,
    text: string
  ): Promise<void> {
    const config = getConfig(this.domain);
    const sequence = {
      "@type": "com.amazon.alexa.behaviors.model.Sequence",
      startNode: {
        "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
        type: "Alexa.Speak",
        operationPayload: {
          deviceType,
          deviceSerialNumber: deviceSerial,
          customerId,
          locale: config.locale,
          textToSpeak: text,
        },
      },
    };
    await this.postApp("/api/behaviors/preview", {
      behaviorId: "PREVIEW",
      sequenceJson: JSON.stringify(sequence),
      status: "ENABLED",
    });
  }

  async announce(customerId: string, text: string): Promise<void> {
    const config = getConfig(this.domain);
    const sequence = {
      "@type": "com.amazon.alexa.behaviors.model.Sequence",
      startNode: {
        "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
        type: "AlexaAnnouncement",
        operationPayload: {
          expireAfter: "PT5S",
          content: [
            {
              locale: config.locale,
              display: { title: "Announcement", body: text },
              speak: { type: "text", value: text },
            },
          ],
          target: { customerId },
        },
      },
    };
    await this.postApp("/api/behaviors/preview", {
      behaviorId: "PREVIEW",
      sequenceJson: JSON.stringify(sequence),
      status: "ENABLED",
    });
  }

  async command(
    deviceSerial: string,
    deviceType: string,
    customerId: string,
    text: string
  ): Promise<void> {
    const config = getConfig(this.domain);
    const sequence = {
      "@type": "com.amazon.alexa.behaviors.model.Sequence",
      startNode: {
        "@type": "com.amazon.alexa.behaviors.model.OpaquePayloadOperationNode",
        type: "Alexa.TextCommand",
        skillId: "amzn1.ask.1p.tellalexa",
        operationPayload: {
          deviceType,
          deviceSerialNumber: deviceSerial,
          customerId,
          locale: config.locale,
          text,
        },
      },
    };
    await this.postApp("/api/behaviors/preview", {
      behaviorId: "PREVIEW",
      sequenceJson: JSON.stringify(sequence),
      status: "ENABLED",
    });
  }

  private normalizeAppliances(appliances: Appliance[]): Appliance[] {
    return appliances.map((a) => ({
      entityId: a.entityId,
      endpointId: a.endpointId,
      friendlyName: a.friendlyName,
      isReachable: a.isReachable,
      ...(a.capabilities ? { capabilities: [...a.capabilities] } : {}),
    }));
  }

  private async fetchAppliancesFromApi(): Promise<Appliance[]> {
    const r = await this.fetchSmarthomeV2Endpoints();
    const rawLayoutKeys = await this.fetchLayouts();
    const layoutIds = rawLayoutKeys
      .filter((id) => id.startsWith("amzn1.") || /^[0-9a-f-]{36}$/i.test(id))
      .map((id) => (id.startsWith("amzn1.") ? id : `amzn1.alexa.endpoint.${id}`));
    const capabilitiesMap = await this.fetchEndpointCapabilities(layoutIds);

    const parseSmarthomeV2Response = (
      data: unknown,
      endpointIds?: string[],
      friendlyNames?: Map<string, string>,
      capabilities?: Map<string, string[]>
    ): Appliance[] => {
      const d = data as {
        endpoints?: Array<{
          __type?: string;
          identifier?: { deviceType?: string; deviceSerialNumber?: string };
          serialNumber?: string;
          deviceType?: string;
          deviceAccountId?: string;
          deviceOwnerCustomerId?: string;
        }>;
      };
      const endpoints = d.endpoints ?? [];
      return endpoints.map((ep, i) => {
        const serial = ep.serialNumber ?? ep.identifier?.deviceSerialNumber ?? "";
        const deviceType = ep.deviceType ?? ep.identifier?.deviceType ?? "";
        const endpointId = endpointIds && i < endpointIds.length ? endpointIds[i] : undefined;
        const friendlyName =
          (endpointId && friendlyNames?.get(endpointId)) ?? serial;
        const caps = endpointId && capabilities ? capabilities.get(endpointId) : undefined;
        return {
          entityId: endpointId ?? serial,
          endpointId,
          applianceId: ep.deviceAccountId ?? serial,
          friendlyName,
          applianceTypes: deviceType ? [deviceType] : [],
          isReachable: true,
          deviceOwnerCustomerId: ep.deviceOwnerCustomerId,
          capabilities: caps,
        };
      });
    };

    const endpoints = (r.data as { endpoints?: unknown[] })?.endpoints ?? [];
    const useLayoutIds =
      layoutIds.length === endpoints.length && layoutIds.length > 0;

    if (r.status !== 200) {
      if (layoutIds.length === 0) return [];
      const friendlyNames = await this.fetchFriendlyNames(layoutIds);
      return layoutIds.map((endpointId) => ({
        entityId: endpointId,
        endpointId,
        applianceId: endpointId,
        friendlyName: friendlyNames.get(endpointId) ?? endpointId,
        applianceTypes: [] as string[],
        isReachable: true,
        capabilities: capabilitiesMap.get(endpointId),
      }));
    }

    let appliances: Appliance[];
    if (useLayoutIds) {
      const friendlyNames = await this.fetchFriendlyNames(layoutIds);
      appliances = parseSmarthomeV2Response(r.data, layoutIds, friendlyNames, capabilitiesMap);
    } else if (layoutIds.length > 0) {
      const friendlyNames = await this.fetchFriendlyNames(layoutIds);
      appliances = layoutIds.map((endpointId) => ({
        entityId: endpointId,
        endpointId,
        applianceId: endpointId,
        friendlyName: friendlyNames.get(endpointId) ?? endpointId,
        applianceTypes: [] as string[],
        isReachable: true,
        capabilities: capabilitiesMap.get(endpointId),
      }));
    } else {
      appliances = parseSmarthomeV2Response(r.data, undefined, undefined, capabilitiesMap);
    }
    const filtered = AlexaClient.filterSmartHomeAppliances(appliances);
    const deduped = AlexaClient.deduplicateAppliances(filtered);
    return deduped.map((a) => ({
      endpointId: a.endpointId,
      entityId: a.endpointId ?? a.entityId,
      friendlyName: a.friendlyName,
      isReachable: a.isReachable,
      capabilities: a.capabilities,
    }));
  }

  private async loadAppliances(): Promise<Appliance[]> {
    if (this.appliancesCache !== null && Date.now() < this.appliancesCache.expiresAt) {
      return this.appliancesCache.appliances;
    }

    const disk = readAppliancesCache(this.domain);
    if (disk) {
      const appliances = this.normalizeAppliances(disk.appliances);
      this.appliancesCache = { appliances, expiresAt: disk.expiresAt };
      return appliances;
    }

    const appliances = this.normalizeAppliances(await this.fetchAppliancesFromApi());
    const expiresAt = Date.now() + DEVICES_CACHE_TTL_MS;
    this.appliancesCache = { appliances, expiresAt };
    writeAppliancesCache(this.domain, appliances, expiresAt);
    return appliances;
  }

  async listAppliances(): Promise<Appliance[]> {
    return this.loadAppliances();
  }

  /**
   * Filter out non-device endpoints from the raw layout list.
   * Removes Fire TV apps (package names), Alexa scenes, Echo devices,
   * VSK endpoints, FireTV launchers, and other non-controllable entries.
   */
  private static filterSmartHomeAppliances(appliances: Appliance[]): Appliance[] {
    const appPackagePattern = /^(com\s|uk\s|org\s)/i;
    const nonDeviceNames = /^(firetv launcher|alexa vsk at unknown)$/i;
    const echoOnlyCaps = new Set(["speaker", "bluetooth", "temperatureSensor", "motionSensor", "detectionEvents"]);
    return appliances.filter((a) => {
      const name = a.friendlyName?.trim() ?? "";
      const caps = a.capabilities ?? [];
      if (appPackagePattern.test(name)) return false;
      if (nonDeviceNames.test(name)) return false;
      if (caps.length === 0) return false;
      if (caps.every((c) => echoOnlyCaps.has(c))) return false;
      return true;
    });
  }

  /**
   * Deduplicate appliances with the same friendly name.
   * Keeps the endpoint with the most capabilities; breaks ties by keeping the last one
   * (more recently registered endpoints tend to be at the end of the layout list).
   */
  private static deduplicateAppliances(appliances: Appliance[]): Appliance[] {
    const byName = new Map<string, Appliance>();
    for (const a of appliances) {
      const key = a.friendlyName?.toLowerCase().trim() ?? "";
      if (!key) continue;
      const existing = byName.get(key);
      if (!existing) {
        byName.set(key, a);
        continue;
      }
      const existingScore = (existing.capabilities ?? []).length;
      const newScore = (a.capabilities ?? []).length;
      if (newScore >= existingScore) {
        byName.set(key, a);
      }
    }
    const dedupedSet = new Set(Array.from(byName.values()).map((a) => a.endpointId ?? a.entityId));
    return appliances.filter((a) => dedupedSet.has(a.endpointId ?? a.entityId));
  }

  /**
   * Resolve smart home device by friendly name.
   * Matching priority: exact > startsWith > contains. Ambiguous matches throw AmbiguousMatchError.
   * Last resort: unique reverse match (query contains a short device name).
   */
  async resolveApplianceByName(name: string): Promise<Appliance | null> {
    const appliances = await this.listAppliances();
    const matched = resolveUniqueMatch(appliances, name, (a) => a.friendlyName ?? "");
    if (matched) return matched;
    const q = name.toLowerCase().trim();
    const reverse = appliances.filter((a) => {
      const fn = a.friendlyName?.toLowerCase().trim() ?? "";
      return fn.length > 2 && q.includes(fn);
    });
    if (reverse.length === 1) return reverse[0];
    if (reverse.length > 1) {
      throw new AmbiguousMatchError(
        name,
        reverse.map((a) => a.friendlyName ?? a.entityId)
      );
    }
    return null;
  }

  /** Rename one smart-home endpoint by friendly name, optionally disambiguated by endpoint ID. */
  async renameAppliance(
    oldName: string,
    newName: string,
    options?: { endpointId?: string; dryRun?: boolean }
  ): Promise<RenameResult | null> {
    const oldNameTrimmed = oldName.trim();
    const newNameTrimmed = newName.trim();
    if (!oldNameTrimmed || !newNameTrimmed) throw new Error("Device names must not be blank");

    const appliances = await this.listAppliances();
    const candidates = options?.endpointId
      ? appliances.filter((appliance) => appliance.endpointId === options.endpointId)
      : appliances;
    const appliance = resolveUniqueMatch(
      candidates,
      oldNameTrimmed,
      (candidate) => candidate.friendlyName ?? ""
    );
    if (!appliance?.endpointId) return null;

    const result: RenameResult = {
      endpointId: appliance.endpointId,
      oldName: appliance.friendlyName,
      newName: newNameTrimmed,
      dryRun: Boolean(options?.dryRun),
    };
    if (options?.dryRun) return result;

    const response = (await this.postGraphql({
      operationName: "RenameEndpointFriendlyName",
      variables: {
        input: { endpointId: appliance.endpointId, friendlyName: newNameTrimmed },
      },
      query: `mutation RenameEndpointFriendlyName($input: SetEndpointFriendlyNameInput!) {
  setEndpointFriendlyName(input: $input) {
    endpoint { id friendlyNameObject { value { text } } }
  }
}`,
    })) as {
      data?: {
        setEndpointFriendlyName?: {
          endpoint?: { id?: string; friendlyNameObject?: { value?: { text?: string } } };
        };
      };
      errors?: Array<{ message?: string }>;
    };
    if (response.errors?.length) {
      throw new Error(
        `GraphQL error: ${response.errors.map((error) => error.message ?? "Unknown error").join("; ")}`
      );
    }
    const renamed = response.data?.setEndpointFriendlyName?.endpoint;
    if (
      renamed?.id !== appliance.endpointId ||
      renamed.friendlyNameObject?.value?.text !== newNameTrimmed
    ) {
      throw new Error("Rename failed: GraphQL response did not confirm the endpoint and friendly name");
    }

    this.appliancesCache = null;
    clearSmartHomeCache(this.domain);
    return result;
  }

  /**
   * Resolve smart home devices by pattern (e.g. "kitchen lights").
   * First tries AND matching (all words must appear in the name, with singular/plural tolerance).
   * If no results, falls back to OR matching (any word matches) so "kitchen lights" still finds
   * "Kitchen spot 1" even though "lights" doesn't appear in the name.
   */
  async resolveAppliancesByPattern(pattern: string): Promise<Appliance[]> {
    const appliances = await this.listAppliances();
    const words = pattern.toLowerCase().trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) return [];
    const matchWord = (fn: string, w: string): boolean => {
      if (fn.includes(w)) return true;
      if (w.endsWith("s") && fn.includes(w.slice(0, -1))) return true; // "lights" → "light"
      if (!w.endsWith("s") && fn.includes(w + "s")) return true; // "light" → "lights"
      return false;
    };
    const andMatches = appliances.filter((a) => {
      const fn = a.friendlyName?.toLowerCase() ?? "";
      return words.every((w) => matchWord(fn, w));
    });
    if (andMatches.length > 0) return andMatches;
    return appliances.filter((a) => {
      const fn = a.friendlyName?.toLowerCase() ?? "";
      return words.some((w) => matchWord(fn, w));
    });
  }

  /**
   * Control all appliances matching a pattern (e.g. "kitchen lights").
   * Uses direct GraphQL/phoenix control—avoids profile/account issues from voice commands.
   * Returns names of controlled devices, errors, and success/partial flags.
   */
  async controlAppliancesByPattern(
    pattern: string,
    action: "turnOn" | "turnOff",
    options?: { dryRun?: boolean }
  ): Promise<{
    controlled: string[];
    errors: string[];
    success: boolean;
    partial: boolean;
    planned?: ControlTarget[];
  }> {
    const appliances = await this.resolveAppliancesByPattern(pattern);
    const id = (a: Appliance) => a.endpointId ?? a.entityId;
    const targets = appliances
      .map((a) => ({
        endpointId: id(a) ?? "",
        name: a.friendlyName ?? a.entityId,
        resolved: true as const,
      }))
      .filter((t) => !!t.endpointId);
    const errors = appliances
      .filter((a) => !id(a))
      .map((a) => `${a.friendlyName ?? "?"}: no endpointId/entityId`);

    if (options?.dryRun) {
      const planned: ControlTarget[] = targets.map((t) => ({
        name: t.name,
        endpointId: t.endpointId,
        resolved: true,
      }));
      return {
        controlled: [],
        errors,
        planned,
        success: planned.length > 0,
        partial: false,
      };
    }

    const results = await Promise.allSettled(targets.map((t) => this.controlAppliance(t.endpointId, action)));
    const controlled: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") controlled.push(targets[i].name);
      else errors.push(`${targets[i].name}: ${String(r.reason)}`);
    });
    return { controlled, errors, ...controlResultFlags(controlled.length, errors.length) };
  }

  async controlAppliance(
    entityId: string,
    action: "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature",
    brightness?: number,
    colorTemperatureInKelvin?: number
  ): Promise<void> {
    const useGraphql = entityId.startsWith("amzn1.alexa.endpoint.");
    if (useGraphql) {
      await this.graphqlControl(entityId, action, brightness, colorTemperatureInKelvin);
      return;
    }
    const params: Record<string, unknown> = { action };
    if (action === "setBrightness") {
      if (brightness === undefined)
        throw new Error("brightness required for setBrightness");
      params.brightness = brightness;
    }
    if (action === "setColorTemperature") {
      if (colorTemperatureInKelvin === undefined)
        throw new Error("colorTemperatureInKelvin required for setColorTemperature");
      params.colorTemperatureInKelvin = colorTemperatureInKelvin;
    }
    await this.putApp("/api/phoenix/state", {
      controlRequests: [
        {
          entityId,
          entityType: "APPLIANCE",
          parameters: params,
        },
      ],
    });
  }

  async setBrightness(entityId: string, brightness: number): Promise<void> {
    const useGraphql = entityId.startsWith("amzn1.alexa.endpoint.");
    if (useGraphql) {
      await this.graphqlControl(entityId, "setBrightness", brightness);
      return;
    }
    await this.putApp("/api/phoenix/state", {
      controlRequests: [
        {
          entityId,
          entityType: "APPLIANCE",
          parameters: { action: "setBrightness", brightness },
        },
      ],
    });
  }

  async setColorTemperature(entityId: string, colorTemperatureInKelvin: number): Promise<void> {
    const useGraphql = entityId.startsWith("amzn1.alexa.endpoint.");
    if (useGraphql) {
      await this.graphqlControl(entityId, "setColorTemperature", undefined, colorTemperatureInKelvin);
      return;
    }
    await this.putApp("/api/phoenix/state", {
      controlRequests: [
        {
          entityId,
          entityType: "APPLIANCE",
          parameters: { action: "setColorTemperature", colorTemperatureInKelvin },
        },
      ],
    });
  }

  /**
   * Batch control multiple appliances with the same action and values.
   * GraphQL endpoints are sent as a single batched mutation (fast); Phoenix endpoints use
   * individual Promise.allSettled calls.
   * Returns a per-device result array: {entityId, success, error?}.
   */
  async batchControlAppliances(
    entityIds: string[],
    action: "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature",
    brightness?: number,
    colorTemperatureInKelvin?: number
  ): Promise<Array<{ entityId: string; success: boolean; error?: string }>> {
    if (entityIds.length === 0) return [];

    const resultMap = new Map<string, { success: boolean; error?: string }>();
    for (const id of entityIds) resultMap.set(id, { success: true });

    // Separate GraphQL and Phoenix endpoints
    const graphqlIds = entityIds.filter(id => id.startsWith("amzn1.alexa.endpoint."));
    const phoenixIds = entityIds.filter(id => !id.startsWith("amzn1.alexa.endpoint."));

    if (graphqlIds.length > 0) {
      const graphqlRequests = graphqlIds.map(endpointId => ({ endpointId, action, brightness, colorTemperatureInKelvin }));
      try {
        const responses = await this.graphqlBatchControl(graphqlRequests);
        for (const r of responses) {
          if (r.code !== "SUCCESS") {
            resultMap.set(r.endpointId, { success: false, error: r.code });
          }
        }
      } catch (e) {
        for (const id of graphqlIds) resultMap.set(id, { success: false, error: String(e) });
      }
    }

    if (phoenixIds.length > 0) {
      const phoenixResults = await Promise.allSettled(
        phoenixIds.map(entityId => this.controlAppliance(entityId, action, brightness, colorTemperatureInKelvin))
      );
      phoenixIds.forEach((id, i) => {
        const r = phoenixResults[i];
        if (r.status === "rejected") resultMap.set(id, { success: false, error: String(r.reason) });
      });
    }

    return entityIds.map(id => ({ entityId: id, ...resultMap.get(id)! }));
  }

  /**
   * Batch control multiple appliances with different actions/values.
   * Maximum flexibility — each device can have different settings.
   * Returns a per-device result array: {entityId, success, error?}.
   */
  async batchControlAppliancesCustom(
    requests: Array<{
      entityId: string;
      action: "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature";
      brightness?: number;
      colorTemperatureInKelvin?: number;
    }>
  ): Promise<Array<{ entityId: string; success: boolean; error?: string }>> {
    if (requests.length === 0) return [];

    const resultMap = new Map<string, { success: boolean; error?: string }>();
    for (const req of requests) resultMap.set(req.entityId, { success: true });

    const graphqlReqs = requests.filter(req => req.entityId.startsWith("amzn1.alexa.endpoint."));
    const phoenixReqs = requests.filter(req => !req.entityId.startsWith("amzn1.alexa.endpoint."));

    if (graphqlReqs.length > 0) {
      const graphqlRequests = graphqlReqs.map(({ entityId, action, brightness, colorTemperatureInKelvin }) => ({
        endpointId: entityId,
        action,
        brightness,
        colorTemperatureInKelvin,
      }));
      try {
        const responses = await this.graphqlBatchControl(graphqlRequests);
        for (const r of responses) {
          if (r.code !== "SUCCESS") {
            resultMap.set(r.endpointId, { success: false, error: r.code });
          }
        }
      } catch (e) {
        for (const req of graphqlReqs) resultMap.set(req.entityId, { success: false, error: String(e) });
      }
    }

    if (phoenixReqs.length > 0) {
      const phoenixResults = await Promise.allSettled(
        phoenixReqs.map(({ entityId, action, brightness, colorTemperatureInKelvin }) =>
          this.controlAppliance(entityId, action, brightness, colorTemperatureInKelvin)
        )
      );
      phoenixReqs.forEach((req, i) => {
        const r = phoenixResults[i];
        if (r.status === "rejected") resultMap.set(req.entityId, { success: false, error: String(r.reason) });
      });
    }

    return requests.map(req => ({ entityId: req.entityId, ...resultMap.get(req.entityId)! }));
  }

  /** Get full automation (includes sequence) from app API. Used for run. */
  async getAutomation(automationId: string): Promise<{ automationId: string; name?: string; sequence?: unknown; sequenceJson?: string } | null> {
    try {
      const data = (await this.getApp(
        `/api/behaviors/automations/${encodeURIComponent(automationId)}`
      )) as { automationId?: string; name?: string; sequence?: unknown; sequenceJson?: string };
      if (!data?.automationId) return null;
      return {
        automationId: data.automationId,
        name: data.name,
        sequence: data.sequence,
        sequenceJson:
          typeof data.sequenceJson === "string"
            ? data.sequenceJson
            : data.sequence != null
              ? JSON.stringify(data.sequence)
              : undefined,
      };
    } catch {
      return null;
    }
  }

  /**
   * List Appliance members of a named room/space group.
   * Separates resolved appliances from unresolved/stale group endpoint IDs.
   * Returns null if no group matches.
   */
  async listGroupMembers(groupName: string): Promise<GroupMembersResult | null> {
    const groups = await this.listDeviceGroupsWithAppliances();
    const group = resolveUniqueMatch(groups, groupName, (g) => g.name);
    if (!group) return null;
    const appliances = await this.listAppliances();
    const uuidToAppliance = new Map<string, Appliance>();
    for (const a of appliances) {
      const eid = a.endpointId ?? a.entityId;
      if (eid) {
        const uuid = eid.replace("amzn1.alexa.endpoint.", "");
        uuidToAppliance.set(uuid.toLowerCase(), a);
      }
    }
    const members: Appliance[] = [];
    const unresolved: string[] = [];
    for (const chrId of group.chrEntityIds) {
      const app = uuidToAppliance.get(chrId.toLowerCase());
      if (app) {
        members.push(app);
      } else {
        const endpointId = chrId.includes(".") ? chrId : `amzn1.alexa.endpoint.${chrId}`;
        unresolved.push(endpointId);
      }
    }
    return {
      group: group.name,
      groupId: group.groupId,
      members,
      unresolved,
    };
  }

  /** GET /api/phoenix/group — room/space groups (Living room, Kitchen, etc.) with appliance membership. */
  async listDeviceGroups(): Promise<DeviceGroup[]> {
    const groups = await this.listDeviceGroupsWithAppliances();
    return groups.map(({ chrEntityIds, ...g }) => ({ ...g, applianceCount: chrEntityIds.length }));
  }

  /** Like listDeviceGroups but includes chrEntityIds for each group (from chrEndpoints). */
  async listDeviceGroupsWithAppliances(): Promise<DeviceGroupWithAppliances[]> {
    const data = (await this.getApp("/api/phoenix/group")) as {
      applianceGroups?: Array<{
        name?: string;
        groupId?: string;
        type?: string;
        chrEndpoints?: Array<{ entityId?: string }>;
      }>;
    };
    const groups = data?.applianceGroups ?? [];
    return groups.map((g) => {
      const chrEntityIds = (g.chrEndpoints ?? [])
        .map((e) => e.entityId)
        .filter((id): id is string => !!id);
      return {
        name: g.name ?? "",
        groupId: g.groupId ?? "",
        type: g.type ?? "SPACE",
        applianceCount: chrEntityIds.length,
        chrEntityIds,
      };
    });
  }

  /**
   * Control appliances in a room/space group by name (e.g. "Kitchen").
   * Uses chrEntityIds from phoenix group → amzn1.alexa.endpoint.{id} for GraphQL.
   * lightsOnly (default true) filters to devices with light/lamp/bulb in friendlyName when available.
   * Unresolved/stale endpoint IDs are skipped by default (reported in `unresolved`);
   * pass includeUnresolved to attempt control on raw IDs.
   */
  async controlAppliancesByGroup(
    groupName: string,
    action: "turnOn" | "turnOff",
    options?: { lightsOnly?: boolean; includeUnresolved?: boolean; dryRun?: boolean }
  ): Promise<GroupControlResult> {
    const groups = await this.listDeviceGroupsWithAppliances();
    const group = resolveUniqueMatch(groups, groupName, (g) => g.name);
    if (!group) {
      throw new Error(`Group not found: "${groupName}". Use list_device_groups to see groups.`);
    }
    const appliances = await this.listAppliances();
    const uuidToAppliance = new Map<string, Appliance>();
    for (const a of appliances) {
      const eid = a.endpointId ?? a.entityId;
      if (eid) {
        const uuid = eid.startsWith("amzn1.alexa.endpoint.") ? eid.replace("amzn1.alexa.endpoint.", "") : eid;
        uuidToAppliance.set(uuid.toLowerCase(), a);
      }
    }
    const lightsOnly = options?.lightsOnly ?? true;
    const includeUnresolved = options?.includeUnresolved ?? false;
    const lightRe = /light|lamp|bulb/i;
    const targets: ControlTarget[] = [];
    const unresolved: string[] = [];
    for (const chrId of group.chrEntityIds) {
      const app = uuidToAppliance.get(chrId.toLowerCase());
      const endpointId = chrId.includes(".") ? chrId : `amzn1.alexa.endpoint.${chrId}`;
      if (!app) {
        unresolved.push(endpointId);
        if (includeUnresolved) {
          targets.push({ endpointId, name: endpointId, resolved: false });
        }
        continue;
      }
      const name = app.friendlyName ?? chrId;
      if (lightsOnly && !lightRe.test(name)) continue;
      targets.push({ endpointId, name, resolved: true });
    }

    if (options?.dryRun) {
      return {
        controlled: [],
        errors: [],
        unresolved,
        planned: targets,
        success: targets.length > 0,
        partial: false,
      };
    }

    const results = await Promise.allSettled(
      targets.map((t) => this.controlAppliance(t.endpointId, action))
    );
    const controlled: string[] = [];
    const errors: string[] = [];
    results.forEach((r, i) => {
      if (r.status === "fulfilled") controlled.push(targets[i].name);
      else errors.push(`${targets[i].name}: ${String(r.reason)}`);
    });
    return {
      controlled,
      errors,
      unresolved,
      ...controlResultFlags(controlled.length, errors.length),
    };
  }

  /** GET /api/wholeHomeAudio/v1/groups — multi-room audio speaker groups (Downstairs, Everywhere, etc.). */
  async listAudioGroups(): Promise<AudioGroup[]> {
    const data = (await this.getApp("/api/wholeHomeAudio/v1/groups")) as {
      groups?: Array<{ id?: string; name?: string; members?: Array<{ deviceType?: string; dsn?: string; speakerChannel?: string }> }>;
    };
    const groups = data?.groups ?? [];
    return groups.map((g) => ({
      id: g.id ?? "",
      name: g.name ?? "",
      members: (g.members ?? []).map((m) => ({
        deviceType: m.deviceType ?? "",
        dsn: m.dsn ?? "",
        speakerChannel: m.speakerChannel ?? "all",
      })),
    }));
  }

  async listRoutines(): Promise<Routine[]> {
    const data = (await this.getApp("/api/routines/routinesandgroups")) as {
      routines?: Array<{
        automationId?: string;
        primary?: string;
        secondary?: string;
        utterance?: string;
        utterances?: string[];
        status?: string;
        type?: string;
      }>;
    };
    const routines = data?.routines ?? [];
    return routines.map((r) => ({
      automationId: r.automationId ?? "",
      name: r.primary ?? r.secondary ?? "",
      sequence: undefined,
      status: r.status,
      type: r.type,
    }));
  }

  /** Resolve a routine by exact or partial name match (case-insensitive). */
  async resolveRoutineByName(name: string, partial = false): Promise<Routine | null> {
    const routines = await this.listRoutines();
    const q = name.toLowerCase().trim();
    if (partial) {
      return routines.find((r) => r.name.toLowerCase().includes(q)) ?? null;
    }
    return routines.find((r) => r.name.toLowerCase() === q) ?? null;
  }

  async runRoutine(automationId: string, sequenceJson?: string): Promise<void> {
    let payload = sequenceJson;
    if (!payload) {
      const automation = await this.getAutomation(automationId);
      payload = automation?.sequenceJson ?? automation?.sequence != null ? JSON.stringify(automation.sequence) : undefined;
      if (!payload) {
        throw new Error(`Could not get sequence for routine ${automationId}. Fetch automation failed or list did not include sequence.`);
      }
    }
    await this.postApp("/api/behaviors/preview", {
      behaviorId: automationId,
      sequenceJson: payload,
      status: "ENABLED",
    });
  }

  /** Media: now-playing state for a device. Returns taskSessionId when something is playing. */
  async getNowPlaying(
    deviceSerialNumber: string,
    deviceType: string
  ): Promise<{ taskSessionId?: string; [key: string]: unknown }> {
    const q = new URLSearchParams({
      deviceSerialNumber,
      deviceType,
      screenWidth: "375",
    });
    const data = (await this.getFromAppApi(
      `/api/np/player?${q.toString()}`
    )) as {
      taskSessionId?: string;
      playerInfo?: {
        taskSessionId?: string;
        state?: string;
        mainArt?: { url?: string };
        infoText?: {
          title?: string;
          subText1?: string;
          subText2?: string;
        };
        miniArt?: { url?: string };
        volume?: { volume?: number; muted?: boolean };
        progress?: { mediaProgress?: number; mediaLength?: number };
      };
      [key: string]: unknown;
    };

    // taskSessionId may be at root or nested inside playerInfo
    let taskSessionId: string | undefined =
      data?.taskSessionId ?? data?.playerInfo?.taskSessionId;

    // Fallback: list-media-sessions returns active sessions with taskSessionId
    if (!taskSessionId) {
      const sq = new URLSearchParams({ deviceSerialNumber, deviceType });
      const sessions = (await this.getFromAppApi(
        `/api/np/list-media-sessions?${sq.toString()}`
      )) as { mediaSessionList?: Array<{ taskSessionId?: string }> };
      taskSessionId = sessions?.mediaSessionList?.[0]?.taskSessionId;
    }

    // Extract friendly now-playing fields from playerInfo
    const pi = data?.playerInfo;
    const nowPlaying = pi
      ? {
          state: pi.state,
          title: pi.infoText?.title,
          artist: pi.infoText?.subText1,
          album: pi.infoText?.subText2,
          volume: pi.volume?.volume,
          muted: pi.volume?.muted,
          artUrl: pi.mainArt?.url ?? pi.miniArt?.url,
          mediaProgress: pi.progress?.mediaProgress,
          mediaLength: pi.progress?.mediaLength,
        }
      : undefined;

    return {
      ...(data ?? {}),
      ...(taskSessionId ? { taskSessionId } : {}),
      ...(nowPlaying ? { nowPlaying } : {}),
    };
  }

  /**
   * Get live state for a smart home endpoint via GraphQL.
   * Returns power state, reachability, brightness (0–100), and color temperature (Kelvin) when available.
   * Works for any endpoint type (lights, plugs, switches, etc.).
   */
  async getEndpointState(endpointId: string): Promise<{ brightness?: number; colorTemperatureInKelvin?: number; powerState?: string; isReachable?: boolean }> {
    try {
      const result = (await this.postGraphql({
        operationName: "EndpointFeaturesQuery",
        variables: { endpointId },
        query: AlexaClient.ENDPOINT_FEATURES_QUERY,
      })) as {
        data?: {
          endpoint?: {
            features?: Array<{
              name?: string;
              properties?: Array<{
                brightnessStateValue?: number;
                colorTemperatureInKelvinStateValue?: number;
                powerStateValue?: string;
                reachabilityStatusValue?: string;
              }>;
            }>;
          };
        };
      };
      const features = result?.data?.endpoint?.features ?? [];
      let brightness: number | undefined;
      let colorTemperatureInKelvin: number | undefined;
      let powerState: string | undefined;
      let reachable: boolean | undefined;
      for (const f of features) {
        for (const p of f.properties ?? []) {
          if (p.brightnessStateValue !== undefined) brightness = p.brightnessStateValue;
          if (p.colorTemperatureInKelvinStateValue !== undefined) colorTemperatureInKelvin = p.colorTemperatureInKelvinStateValue;
          if (p.powerStateValue !== undefined) powerState = p.powerStateValue;
          if (p.reachabilityStatusValue !== undefined) reachable = p.reachabilityStatusValue === "REACHABLE";
        }
      }
      return { brightness, colorTemperatureInKelvin, powerState, isReachable: reachable };
    } catch {
      return {};
    }
  }

  /** Get volume for a device (0–100). */
  async getVolume(
    deviceType: string,
    deviceSerialNumber: string
  ): Promise<{ volume: number; muted?: boolean }> {
    const data = (await this.getFromAppApi(
      `/api/devices/${encodeURIComponent(deviceType)}/${encodeURIComponent(deviceSerialNumber)}/audio/v2/volume`
    )) as { speakerVolume?: number; speakerMuted?: boolean };
    return { volume: data?.speakerVolume ?? 0, muted: data?.speakerMuted };
  }

  /** Set volume for a device (0–100). */
  async setVolume(
    deviceType: string,
    deviceSerialNumber: string,
    volume: number
  ): Promise<void> {
    await this.postApp(
      `/api/devices/${encodeURIComponent(deviceType)}/${encodeURIComponent(deviceSerialNumber)}/audio/v2/speakerVolume`,
      { volume }
    );
  }

  /** Media: list active media sessions. */
  async listMediaSessions(): Promise<unknown> {
    return this.getFromAppApi("/api/np/list-media-sessions");
  }

  /** Media: transport control (play, pause, resume, stop, next, previous). */
  async controlMediaSession(
    device: Device,
    taskSessionId: string,
    command:
      | "play"
      | "pause"
      | "resume"
      | "stop"
      | "next"
      | "previous"
  ): Promise<void> {
    const commandTypes: Record<string, string> = {
      play: "NPPlayCommand",
      pause: "NPPauseCommand",
      resume: "NPResumeCommand",
      stop: "NPStopCommand",
      next: "NPNextCommand",
      previous: "NPPreviousCommand",
    };
    const typeName = commandTypes[command];
    if (!typeName) throw new Error(`Unknown media command: ${command}`);

    const controllerEndpoint = {
      __type: "NPSingletonEndpoint:http://internal.amazon.com/coral/com.amazon.dee.web.coral.model/",
      id: {
        __type: "NPEndpointIdentifier:http://internal.amazon.com/coral/com.amazon.dee.web.coral.model/",
        deviceSerialNumber: device.serialNumber,
        deviceType: device.deviceType,
      },
    };

    await this.postFromAppApi("/api/np/control-media-session", {
      taskSessionId,
      command: { type: typeName },
      controllerEndpoint,
    });
  }
}
