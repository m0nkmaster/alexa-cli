import { describe, it, expect, vi, beforeEach } from "vitest";
import { AlexaClient } from "../src/client.js";
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

/** Response-like mock: client uses res.text() then JSON.parse, so provide text(). */
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

describe("AlexaClient", () => {
  let client: AlexaClient;

  useIsolatedDevicesCache();

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    client = new AlexaClient({ refreshToken: "Atnr|test" });
  });

  it("getDevices returns devices from API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        devices: [
          {
            accountName: "Office Echo",
            serialNumber: "G090",
            deviceType: "A1RAB",
            deviceFamily: "ECHO",
            deviceOwnerCustomerId: "ARK5DC",
            online: true,
          },
        ],
      })
    );

    const devices = await client.getDevices();

    expect(devices).toHaveLength(1);
    expect(devices[0].accountName).toBe("Office Echo");
    expect(devices[0].serialNumber).toBe("G090");
  });

  it("resolveDevice finds device by name", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        devices: [
          {
            accountName: "Office Echo",
            serialNumber: "G090",
            deviceType: "A1RAB",
            deviceFamily: "ECHO",
            deviceOwnerCustomerId: "ARK5DC",
            online: true,
          },
        ],
      })
    );

    const d = await client.resolveDevice("Office");

    expect(d).not.toBeNull();
    expect(d!.accountName).toBe("Office Echo");
  });

  it("resolveDevice returns null when not found", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        devices: [
          {
            accountName: "Office Echo",
            serialNumber: "G090",
            deviceType: "A1RAB",
            deviceFamily: "ECHO",
            deviceOwnerCustomerId: "ARK5DC",
            online: true,
          },
        ],
      })
    );

    const d = await client.resolveDevice("nonexistent");

    expect(d).toBeNull();
  });

  it("listAppliances returns appliances from v2/endpoints when eu-api", async () => {
    const uuid = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";
    const endpointId = `amzn1.alexa.endpoint.${uuid}`;
    // v2/endpoints
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        endpoints: [
          {
            serialNumber: "s1",
            deviceType: "LIGHT",
            deviceAccountId: "a1",
          },
        ],
      })
    );
    // layouts with matching UUID
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ layouts: { [uuid]: { type: "None" } } }));
    // GraphQL capabilities batch
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{
        data: { endpoint: { id: endpointId, features: [{ name: "power" }, { name: "brightness" }] } },
      }])
    );
    // GraphQL friendly names batch
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{
        data: { endpoint: { id: endpointId, friendlyNameObject: { value: { text: "Lounge lamp" } } } },
      }])
    );

    const appliances = await client.listAppliances();

    expect(appliances).toHaveLength(1);
    expect(appliances[0].friendlyName).toBe("Lounge lamp");
    expect(appliances[0].endpointId).toBe(endpointId);
    expect(appliances[0].capabilities).toEqual(["power", "brightness"]);
  });

  it("listAppliances returns empty when eu-api v2 returns no endpoints", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ endpoints: [] }));
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ layouts: {} }));

    const appliances = await client.listAppliances();

    expect(appliances).toHaveLength(0);
  });

  it("getVolume returns volume from API", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ speakerVolume: 50, speakerMuted: false }));

    const vol = await client.getVolume("A1RABVCI4QCIKC", "G090XG123");

    expect(vol.volume).toBe(50);
    expect(vol.muted).toBe(false);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/devices/A1RABVCI4QCIKC/G090XG123/audio/v2/volume"),
      expect.any(Object)
    );
  });

  it("getVolume returns 0 when API returns empty", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({}));

    const vol = await client.getVolume("A1RABVCI4QCIKC", "G090XG123");

    expect(vol.volume).toBe(0);
  });

  it("setVolume calls POST with correct body", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({}));

    await client.setVolume("A1RABVCI4QCIKC", "G090XG123", 75);

    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("/api/devices/A1RABVCI4QCIKC/G090XG123/audio/v2/speakerVolume"),
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ volume: 75 }),
      })
    );
  });

  it("getEndpointState returns brightness from GraphQL", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        data: {
          endpoint: {
            id: "amzn1.alexa.endpoint.abc123",
            enablement: "ENABLED",
            features: [
              { name: "brightness", properties: [{ brightnessStateValue: 75, __typename: "Brightness" }] },
              { name: "power", properties: [{ powerStateValue: "ON", __typename: "Power" }] },
              { name: "reachability", properties: [{ reachabilityStatusValue: "REACHABLE", __typename: "Reachability" }] },
            ],
          },
        },
      })
    );

    const state = await client.getEndpointState("amzn1.alexa.endpoint.abc123");

    expect(state.brightness).toBe(75);
    expect(state.powerState).toBe("ON");
    expect(state.isReachable).toBe(true);
  });

  it("getEndpointState reports unreachable devices", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        data: {
          endpoint: {
            id: "amzn1.alexa.endpoint.offline",
            enablement: "ENABLED",
            features: [
              { name: "brightness", properties: [{ brightnessStateValue: 10, __typename: "Brightness" }] },
              { name: "power", properties: [{ powerStateValue: "ON", __typename: "Power" }] },
              { name: "reachability", properties: [{ reachabilityStatusValue: "UNREACHABLE", __typename: "Reachability" }] },
            ],
          },
        },
      })
    );

    const state = await client.getEndpointState("amzn1.alexa.endpoint.offline");

    expect(state.isReachable).toBe(false);
    expect(state.brightness).toBe(10);
    expect(state.powerState).toBe("ON");
  });

  it("getEndpointState returns empty object on API error", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes({ errors: ["not found"] }, false));

    const state = await client.getEndpointState("amzn1.alexa.endpoint.unknown");

    expect(state.brightness).toBeUndefined();
    expect(state.powerState).toBeUndefined();
  });

  it("listAppliances returns appliances from app API (US)", async () => {
    const usClient = new AlexaClient({ refreshToken: "Atnr|test", domain: "amazon.com" });
    const uuid = "f1e2d3c4-b5a6-7890-1234-567890abcdef";
    const endpointId = `amzn1.alexa.endpoint.${uuid}`;
    // v2/endpoints
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({
        endpoints: [
          {
            serialNumber: "s1",
            deviceType: "LIGHT",
            deviceAccountId: "a1",
            __type: "DmsEndpoint",
          },
        ],
      })
    );
    // layouts with valid UUID
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes({ layouts: { [uuid]: { type: "None" } } })
    );
    // GraphQL capabilities batch
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{
        data: { endpoint: { id: endpointId, features: [{ name: "power" }] } },
      }])
    );
    // GraphQL friendly names batch
    vi.mocked(fetch).mockResolvedValueOnce(
      mockRes([{
        data: { endpoint: { id: endpointId, friendlyNameObject: { value: { text: "Living room light" } } } },
      }])
    );

    const appliances = await usClient.listAppliances();

    expect(appliances).toHaveLength(1);
    expect(appliances[0].friendlyName).toBe("Living room light");
    expect(appliances[0].endpointId).toBe(endpointId);
    expect(fetch).toHaveBeenCalledWith(
      expect.stringContaining("na-api-alexa.amazon.com"),
      expect.any(Object)
    );
  });
});
