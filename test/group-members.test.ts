import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlexaClient, AmbiguousMatchError } from "../src/client.js";
import { useIsolatedDevicesCache } from "./test-cache.js";

vi.mock("undici", () => ({
  fetch: vi.fn(),
}));

vi.mock("../src/auth.js", () => ({
  authenticate: vi.fn().mockResolvedValue({
    cookies: "session-id=1; csrf=xyz",
    csrf: "xyz",
  }),
}));

const { fetch } = await import("undici");

function mockRes(body: unknown, ok = true): {
  ok: boolean;
  status: number;
  text: () => Promise<string>;
  json: () => Promise<unknown>;
} {
  const str = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status: ok ? 200 : 400,
    text: async () => str,
    json: async () => (typeof body === "string" ? JSON.parse(body) : body),
  };
}

function mockDevices(...names: string[]) {
  return mockRes({
    devices: names.map((accountName, i) => ({
      accountName,
      serialNumber: `S${i}`,
      deviceType: "A1RAB",
      deviceFamily: "ECHO",
      deviceOwnerCustomerId: "CUST",
      online: true,
    })),
  });
}

describe("resolveDevice matching", () => {
  let client: AlexaClient;

  useIsolatedDevicesCache();

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    client = new AlexaClient({ refreshToken: "Atnr|test" });
  });

  it("prefers exact name match", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockDevices("Office", "Office Echo"));
    const d = await client.resolveDevice("Office");
    expect(d!.accountName).toBe("Office");
  });

  it("throws on ambiguous contains match", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockDevices("Lounge Echo", "Lounge Dot"));
    await expect(client.resolveDevice("Lounge")).rejects.toBeInstanceOf(AmbiguousMatchError);
  });
});

describe("listGroupMembers resolved vs unresolved", () => {
  let client: AlexaClient;

  useIsolatedDevicesCache();

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    client = new AlexaClient({ refreshToken: "Atnr|test" });
  });

  it("separates resolved members from unresolved endpoint IDs", async () => {
    const knownUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const staleUuid = "11111111-2222-3333-4444-555555555555";
    const endpointId = `amzn1.alexa.endpoint.${knownUuid}`;

    // listDeviceGroupsWithAppliances → getApp /api/phoenix/group
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        applianceGroups: [
          {
            name: "Kitchen",
            groupId: "g1",
            type: "SPACE",
            chrEndpoints: [{ entityId: knownUuid }, { entityId: staleUuid }],
          },
        ],
      })
    );

    // listAppliances: v2/endpoints
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        endpoints: [{ serialNumber: "s1", deviceType: "LIGHT", deviceAccountId: "a1" }],
      })
    );
    // layouts
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ layouts: { [knownUuid]: { type: "None" } } }));
    // capabilities
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{ data: { endpoint: { id: endpointId, features: [{ name: "power" }] } } }])
    );
    // friendly names
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([
        {
          data: {
            endpoint: {
              id: endpointId,
              friendlyNameObject: { value: { text: "Kitchen spot 1" } },
            },
          },
        },
      ])
    );

    const result = await client.listGroupMembers("Kitchen");
    expect(result).not.toBeNull();
    expect(result!.group).toBe("Kitchen");
    expect(result!.members).toHaveLength(1);
    expect(result!.members[0].friendlyName).toBe("Kitchen spot 1");
    expect(result!.unresolved).toEqual([`amzn1.alexa.endpoint.${staleUuid}`]);
  });
});

describe("controlAppliancesByGroup skips unresolved by default", () => {
  let client: AlexaClient;

  useIsolatedDevicesCache();

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    client = new AlexaClient({ refreshToken: "Atnr|test" });
  });

  it("reports unresolved and does not control them without includeUnresolved", async () => {
    const knownUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const staleUuid = "11111111-2222-3333-4444-555555555555";
    const endpointId = `amzn1.alexa.endpoint.${knownUuid}`;

    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        applianceGroups: [
          {
            name: "Kitchen",
            groupId: "g1",
            type: "SPACE",
            chrEndpoints: [{ entityId: knownUuid }, { entityId: staleUuid }],
          },
        ],
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        endpoints: [{ serialNumber: "s1", deviceType: "LIGHT", deviceAccountId: "a1" }],
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ layouts: { [knownUuid]: { type: "None" } } }));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{ data: { endpoint: { id: endpointId, features: [{ name: "power" }, { name: "brightness" }] } } }])
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([
        {
          data: {
            endpoint: {
              id: endpointId,
              friendlyNameObject: { value: { text: "Kitchen light" } },
            },
          },
        },
      ])
    );
    // GraphQL control for the one resolved light
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ data: { setEndpointFeatures: { code: "SUCCESS" } } }));

    const result = await client.controlAppliancesByGroup("Kitchen", "turnOff");
    expect(result.controlled).toEqual(["Kitchen light"]);
    expect(result.unresolved).toEqual([`amzn1.alexa.endpoint.${staleUuid}`]);
    expect(result.errors).toEqual([]);
    expect(result.success).toBe(true);
    expect(result.partial).toBe(false);
  });

  it("dry-run returns planned targets without controlling", async () => {
    const knownUuid = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
    const endpointId = `amzn1.alexa.endpoint.${knownUuid}`;

    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        applianceGroups: [
          {
            name: "Kitchen",
            groupId: "g1",
            type: "SPACE",
            chrEndpoints: [{ entityId: knownUuid }],
          },
        ],
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        endpoints: [{ serialNumber: "s1", deviceType: "LIGHT", deviceAccountId: "a1" }],
      })
    );
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ layouts: { [knownUuid]: { type: "None" } } }));
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{ data: { endpoint: { id: endpointId, features: [{ name: "power" }] } } }])
    );
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([
        {
          data: {
            endpoint: {
              id: endpointId,
              friendlyNameObject: { value: { text: "Kitchen light" } },
            },
          },
        },
      ])
    );

    const result = await client.controlAppliancesByGroup("Kitchen", "turnOff", { dryRun: true });
    expect(result.controlled).toEqual([]);
    expect(result.planned).toEqual([
      { name: "Kitchen light", endpointId, resolved: true },
    ]);
    expect(result.success).toBe(true);
    // Only group + appliances fetches — no control call
    expect(vi.mocked(fetch).mock.calls.length).toBe(5);
  });
});
