import { describe, it, expect } from "vitest";
import { loadRefreshToken } from "../src/auth.js";
import { AlexaClient } from "../src/client.js";

describe.skipIf(!process.env.TEST_INTEGRATION)("integration", () => {
  it("getDevices returns real devices", async () => {
    const token = loadRefreshToken();
    if (!token) {
      throw new Error("ALEXA_REFRESH_TOKEN or ~/.alexa-cli/config.json required");
    }
    const client = new AlexaClient({ refreshToken: token });
    const devices = await client.getDevices();
    expect(Array.isArray(devices)).toBe(true);
    if (devices.length > 0) {
      expect(devices[0]).toHaveProperty("accountName");
      expect(devices[0]).toHaveProperty("serialNumber");
      expect(devices[0]).toHaveProperty("deviceType");
    }
  });
});
