import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execCli } from "./e2e-harness.js";

const LAMP = "Kitchen Spot";
const SOCKET = "Lounge Lamp";
const ECHO = "Lounge Echo";
const GROUP = "Living Room";

const TEST_TIMEOUT = 20_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


describe.skipIf(!process.env.TEST_INTEGRATION)("e2e device control", () => {
  beforeAll(async () => {
    const { stdout, stderr, code } = await execCli(["auth", "status", "--verify"]);
    const out = stdout + stderr;
    if (code !== 0 || !out.includes("Status: valid")) {
      throw new Error(
        `E2E requires valid Alexa credentials.\n` +
          `Run: alexa-cli auth login --interactive\n` +
          `Or:  ALEXA_REFRESH_TOKEN=<token> npm run test:e2e:devices\n` +
          `auth status output: ${out.trim()}`
      );
    }
  }, 15_000);

  // ---------------------------------------------------------------------------
  // Device discovery
  // ---------------------------------------------------------------------------
  describe("device discovery", () => {
    it(
      `'${ECHO}' appears in devices list`,
      async () => {
        const { stdout, code } = await execCli(["devices"]);
        expect(code).toBe(0);
        const devices = JSON.parse(stdout.trim()) as Array<{ accountName: string }>;
        const found = devices.some((d) =>
          d.accountName.toLowerCase().includes(ECHO.toLowerCase())
        );
        expect(found, `Expected to find "${ECHO}" in devices`).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      `'${LAMP}' appears in appliances list`,
      async () => {
        const { stdout, code } = await execCli(["appliances"]);
        expect(code).toBe(0);
        const appliances = JSON.parse(stdout.trim()) as Array<{ friendlyName: string }>;
        const found = appliances.some((a) =>
          a.friendlyName.toLowerCase().includes(LAMP.toLowerCase())
        );
        expect(found, `Expected to find "${LAMP}" in appliances`).toBe(true);
      },
      TEST_TIMEOUT
    );

    it(
      `'${GROUP}' appears in groups list`,
      async () => {
        const { stdout, code } = await execCli(["groups"]);
        expect(code).toBe(0);
        const groups = JSON.parse(stdout.trim()) as Array<{ name: string }>;
        const found = groups.some((g) =>
          g.name.toLowerCase().includes(GROUP.toLowerCase())
        );
        expect(found, `Expected to find "${GROUP}" in groups`).toBe(true);
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Lounge Lamp — plug socket on/off
  // ---------------------------------------------------------------------------
  describe(`${SOCKET} (plug socket)`, () => {
    it(
      "turns on",
      async () => {
        const { stdout, stderr, code } = await execCli(["switch", SOCKET, "on"]);
        expect(code, stderr).toBe(0);
        const out = stdout + stderr;
        expect(out).toMatch(/turnOn|turn on|done/i);
      },
      TEST_TIMEOUT
    );

    it(
      "turns off",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli(["switch", SOCKET, "off"]);
        expect(code, stderr).toBe(0);
        const out = stdout + stderr;
        expect(out).toMatch(/turnOff|turn off|done/i);
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Living Room group — on/off all sockets/lights/lamps
  // ---------------------------------------------------------------------------
  describe(`${GROUP} (group)`, () => {
    it(
      "turns on all lights in group",
      async () => {
        const { stdout, stderr, code } = await execCli(["switch-group", GROUP, "on"]);
        expect(code, stderr).toBe(0);
        const out = stdout + stderr;
        expect(out).toMatch(/turnOn/i);
      },
      TEST_TIMEOUT
    );

    it(
      "turns off all lights in group",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli(["switch-group", GROUP, "off"]);
        expect(code, stderr).toBe(0);
        const out = stdout + stderr;
        expect(out).toMatch(/turnOff/i);
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Lounge Echo — TTS
  // ---------------------------------------------------------------------------
  describe(`${ECHO} (TTS)`, () => {
    it(
      "speaks text",
      async () => {
        const { stdout, stderr, code } = await execCli([
          "speak",
          "Alexa MCP end to end test",
          "--device",
          ECHO,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Spoke on");
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Lounge Echo — music playback and media transport
  // ---------------------------------------------------------------------------
  describe(`${ECHO} (music playback)`, () => {
    beforeAll(async () => {
      // Start music and give Alexa time to begin playback before transport tests
      await execCli(["command", "play some jazz music", "--device", ECHO]);
      await sleep(5_000);
    }, 30_000);

    afterAll(async () => {
      // Best-effort cleanup — stop any active playback when the suite finishes
      await execCli(["command", "stop", "--device", ECHO]);
    }, 15_000);

    it(
      "sends voice command to play music",
      async () => {
        const { stdout, stderr, code } = await execCli([
          "command",
          "play some jazz music",
          "--device",
          ECHO,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Command sent to");
      },
      TEST_TIMEOUT
    );

    it(
      "now-playing returns JSON with device name and enhanced metadata",
      async () => {
        const { stdout, stderr, code } = await execCli(["now-playing", "--device", ECHO]);
        expect(code, stderr).toBe(0);
        const data = JSON.parse(stdout.trim()) as Record<string, unknown>;
        expect(typeof data).toBe("object");
        expect((data.device as string).toLowerCase()).toContain(
          ECHO.toLowerCase()
        );
        // Enhanced now-playing should include nowPlaying object with metadata
        if (data.nowPlaying) {
          const nowPlaying = data.nowPlaying as Record<string, unknown>;
          // Should have at least some metadata fields when music is playing
          expect(nowPlaying).toBeDefined();
          // State should be present (playing/paused)
          if (nowPlaying.state) {
            expect(typeof nowPlaying.state).toBe("string");
          }
        }
      },
      TEST_TIMEOUT
    );

    it(
      "pauses music",
      async () => {
        await sleep(3_000);
        const { stdout, stderr, code } = await execCli([
          "media",
          "pause",
          "--device",
          ECHO,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("pause sent to");
      },
      TEST_TIMEOUT
    );

    it(
      "resumes music",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli([
          "media",
          "resume",
          "--device",
          ECHO,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("resume sent to");
      },
      TEST_TIMEOUT
    );

    it(
      "stops music",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli([
          "command",
          "stop",
          "--device",
          ECHO,
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Command sent to");
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Lounge Echo — volume control
  // ---------------------------------------------------------------------------
  describe(`${ECHO} (volume control)`, () => {
    let originalVolume: number;

    it(
      "gets current volume",
      async () => {
        const { stdout, stderr, code } = await execCli(["volume", "--device", ECHO]);
        expect(code, stderr).toBe(0);
        const data = JSON.parse(stdout.trim()) as { device: string; volume: number; muted?: boolean };
        expect(data.device.toLowerCase()).toContain(ECHO.toLowerCase());
        expect(typeof data.volume).toBe("number");
        expect(data.volume).toBeGreaterThanOrEqual(0);
        expect(data.volume).toBeLessThanOrEqual(100);
        originalVolume = data.volume;
      },
      TEST_TIMEOUT
    );

    it(
      "sets volume to 30",
      async () => {
        const { stdout, stderr, code } = await execCli(["volume", "30", "--device", ECHO]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Volume set to 30");
      },
      TEST_TIMEOUT
    );

    it(
      "verifies volume was set to 30",
      async () => {
        await sleep(3_000);
        const { stdout, stderr, code } = await execCli(["volume", "--device", ECHO]);
        expect(code, stderr).toBe(0);
        const data = JSON.parse(stdout.trim()) as { volume: number };
        expect(data.volume).toBe(30);
      },
      TEST_TIMEOUT
    );

    it(
      "restores original volume",
      async () => {
        if (originalVolume !== undefined) {
          const { stdout, stderr, code } = await execCli([
            "volume",
            String(originalVolume),
            "--device",
            ECHO,
          ]);
          expect(code, stderr).toBe(0);
          expect(stdout + stderr).toContain(`Volume set to ${originalVolume}`);
        }
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Kitchen Spot — brightness control by name
  // ---------------------------------------------------------------------------
  describe(`${LAMP} (brightness control)`, () => {
    let originalBrightness: number | undefined;

    beforeAll(async () => {
      // Ensure light is on before brightness tests
      await execCli(["switch", LAMP, "on"]);
      await sleep(2_000);
    }, 15_000);

    it(
      "gets current brightness by name",
      async () => {
        const { stdout, stderr, code } = await execCli(["brightness", "--name", LAMP]);
        expect(code, stderr).toBe(0);
        const data = JSON.parse(stdout.trim()) as {
          device: string;
          brightness?: number;
          powerState?: string;
        };
        expect(data.device.toLowerCase()).toContain(LAMP.toLowerCase());
        if (data.brightness !== undefined) {
          expect(typeof data.brightness).toBe("number");
          expect(data.brightness).toBeGreaterThanOrEqual(0);
          expect(data.brightness).toBeLessThanOrEqual(100);
          originalBrightness = data.brightness;
        }
        if (data.powerState) {
          expect(typeof data.powerState).toBe("string");
        }
      },
      TEST_TIMEOUT
    );

    it(
      "sets brightness to 50% by name",
      async () => {
        const { stdout, stderr, code } = await execCli(["brightness", "50", "--name", LAMP]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Brightness set to 50%");
      },
      TEST_TIMEOUT
    );

    it(
      "verifies brightness was set to 50%",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli(["brightness", "--name", LAMP]);
        expect(code, stderr).toBe(0);
        const data = JSON.parse(stdout.trim()) as { brightness?: number };
        if (data.brightness !== undefined) {
          expect(data.brightness).toBe(50);
        }
      },
      TEST_TIMEOUT
    );

    it(
      "sets brightness to 100% by name",
      async () => {
        await sleep(2_000);
        const { stdout, stderr, code } = await execCli(["brightness", "100", "--name", LAMP]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Brightness set to 100%");
      },
      TEST_TIMEOUT
    );

    it(
      "restores original brightness if captured",
      async () => {
        if (originalBrightness !== undefined) {
          await sleep(2_000);
          const { stdout, stderr, code } = await execCli([
            "brightness",
            String(originalBrightness),
            "--name",
            LAMP,
          ]);
          expect(code, stderr).toBe(0);
          expect(stdout + stderr).toContain(`Brightness set to ${originalBrightness}%`);
        }
      },
      TEST_TIMEOUT
    );
  });

  // ---------------------------------------------------------------------------
  // Lounge Echo — announce
  // ---------------------------------------------------------------------------
  describe.skip(`${ECHO} (announce)`, () => {
    beforeAll(async () => {
      // Rate-limit guard: behaviors/preview API enforces ~1 req/5s per account
      await sleep(5_000);
    }, 10_000);

    it(
      "sends announcement to all devices",
      async () => {
        const { stdout, stderr, code } = await execCli([
          "announce",
          "Alexa MCP test complete",
        ]);
        expect(code, stderr).toBe(0);
        expect(stdout + stderr).toContain("Announcement sent");
      },
      TEST_TIMEOUT
    );
  });
});
