import { beforeEach, describe, expect, it, vi } from "vitest";
import { AlexaClient, AmbiguousMatchError } from "../src/client.js";
import {
  DEVICES_CACHE_TTL_MS,
  readAppliancesCache,
  writeAppliancesCache,
} from "../src/devices-cache.js";
import { useIsolatedDevicesCache } from "./test-cache.js";

vi.mock("undici", () => ({ fetch: vi.fn() }));
vi.mock("../src/auth.js", () => ({
  authenticate: vi.fn().mockResolvedValue({ cookies: "session-id=1; csrf=xyz", csrf: "xyz" }),
}));

const { fetch } = await import("undici");
const firstUuid = "11111111-1111-4111-8111-111111111111";
const secondUuid = "22222222-2222-4222-8222-222222222222";
const firstEndpointId = `amzn1.alexa.endpoint.${firstUuid}`;
const secondEndpointId = `amzn1.alexa.endpoint.${secondUuid}`;

function mockRes(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    text: async () => text,
    json: async () => body,
  };
}

function cacheAppliances(
  appliances = [
    {
      entityId: firstEndpointId,
      endpointId: firstEndpointId,
      friendlyName: "Reading lamp",
      isReachable: true,
      capabilities: ["power", "brightness"],
    },
  ]
): void {
  writeAppliancesCache("amazon.co.uk", appliances, Date.now() + DEVICES_CACHE_TTL_MS);
}

function renameResponse(endpointId = firstEndpointId, name = "Reading light") {
  return {
    data: {
      setEndpointFriendlyName: {
        endpoint: { id: endpointId, friendlyNameObject: { value: { text: name } } },
      },
    },
  };
}

describe("smart-home rename", () => {
  useIsolatedDevicesCache();

  beforeEach(() => {
    vi.mocked(fetch).mockReset();
    cacheAppliances();
  });

  it("renames with the confirmed GraphQL schema and refreshes memory and disk caches", async () => {
    const client = new AlexaClient({ refreshToken: "Atnr|test" });
    await client.listAppliances();
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockRes(renameResponse()))
      .mockResolvedValueOnce(
        mockRes({ endpoints: [{ serialNumber: "s1", deviceType: "LIGHT", deviceAccountId: "a1" }] })
      )
      .mockResolvedValueOnce(mockRes({ layouts: { [firstUuid]: { type: "None" } } }))
      .mockResolvedValueOnce(
        mockRes([{ data: { endpoint: { id: firstEndpointId, features: [{ name: "power" }] } } }])
      )
      .mockResolvedValueOnce(
        mockRes([
          {
            data: {
              endpoint: {
                id: firstEndpointId,
                friendlyNameObject: { value: { text: "Reading light" } },
              },
            },
          },
        ])
      );

    const result = await client.renameAppliance("Reading lamp", " Reading light ");

    expect(result).toEqual({
      endpointId: firstEndpointId,
      oldName: "Reading lamp",
      newName: "Reading light",
      dryRun: false,
    });
    expect(readAppliancesCache("amazon.co.uk")).toBeNull();
    const mutationBody = JSON.parse(String(vi.mocked(fetch).mock.calls[0][1]?.body));
    expect(mutationBody.variables).toEqual({
      input: { endpointId: firstEndpointId, friendlyName: "Reading light" },
    });
    expect(mutationBody.query).toContain("endpoint { id friendlyNameObject { value { text } } }");

    const refreshed = await client.listAppliances();
    expect(refreshed[0].friendlyName).toBe("Reading light");
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it.each([
    [{ errors: [{ message: "Invalid input" }] }, /GraphQL error: Invalid input/],
    [{}, /did not confirm/],
    [renameResponse(secondEndpointId), /did not confirm/],
    [renameResponse(firstEndpointId, "Wrong name"), /did not confirm/],
  ])("rejects operation errors or malformed success responses", async (body, message) => {
    vi.mocked(fetch).mockResolvedValueOnce(mockRes(body));
    const client = new AlexaClient({ refreshToken: "Atnr|test" });

    await expect(client.renameAppliance("Reading lamp", "Reading light")).rejects.toThrow(message);
    expect(readAppliancesCache("amazon.co.uk")).not.toBeNull();
  });

  it("rejects ambiguous names unless an exact endpoint ID selects one", async () => {
    cacheAppliances([
      {
        entityId: firstEndpointId,
        endpointId: firstEndpointId,
        friendlyName: "Reading lamp",
        isReachable: true,
      },
      {
        entityId: secondEndpointId,
        endpointId: secondEndpointId,
        friendlyName: "Reading lamp",
        isReachable: true,
      },
    ]);
    const client = new AlexaClient({ refreshToken: "Atnr|test" });

    await expect(client.renameAppliance("Reading lamp", "Reading light")).rejects.toBeInstanceOf(
      AmbiguousMatchError
    );
    vi.mocked(fetch).mockResolvedValueOnce(mockRes(renameResponse(secondEndpointId)));
    const selected = await client.renameAppliance("Reading lamp", "Reading light", {
      endpointId: secondEndpointId,
    });

    expect(selected?.endpointId).toBe(secondEndpointId);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("returns null for a missing name or endpoint without mutating", async () => {
    const client = new AlexaClient({ refreshToken: "Atnr|test" });

    await expect(client.renameAppliance("Missing lamp", "New name")).resolves.toBeNull();
    await expect(
      client.renameAppliance("Reading lamp", "New name", { endpointId: secondEndpointId })
    ).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("dry-run returns the resolved plan without mutating or invalidating cache", async () => {
    const client = new AlexaClient({ refreshToken: "Atnr|test" });

    const result = await client.renameAppliance("Reading", "Reading light", { dryRun: true });

    expect(result?.dryRun).toBe(true);
    expect(result?.endpointId).toBe(firstEndpointId);
    expect(fetch).not.toHaveBeenCalled();
    expect(readAppliancesCache("amazon.co.uk")).not.toBeNull();
  });

  it("rejects blank names before discovery", async () => {
    const client = new AlexaClient({ refreshToken: "Atnr|test" });

    await expect(client.renameAppliance("Reading lamp", " ")).rejects.toThrow(
      "Device names must not be blank"
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});
