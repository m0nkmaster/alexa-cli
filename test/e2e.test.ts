import { describe, it, expect, beforeAll } from "vitest";
import { execCli } from "./e2e-harness.js";

describe.skipIf(!process.env.TEST_INTEGRATION)("e2e CLI", () => {
  beforeAll(async () => {
    const { code } = await execCli(["auth", "status"]);
    if (code !== 0) {
      throw new Error("E2E requires auth. Run: alexa-cli auth login --interactive");
    }
  });

  it("auth status returns domain and token", async () => {
    const { stdout, stderr, code } = await execCli(["auth", "status"]);
    expect(code).toBe(0);
    expect(stdout + stderr).toContain("Domain:");
    expect(stdout + stderr).toContain("Token:");
  });

  it("auth status --verify returns valid status", async () => {
    const { stdout, stderr, code } = await execCli(["auth", "status", "--verify"]);
    expect(code).toBe(0);
    expect(stdout + stderr).toMatch(/Status:\s*valid/);
  });

  it("devices returns JSON array", async () => {
    const { stdout, code } = await execCli(["devices"]);
    expect(code).toBe(0);
    const out = stdout.trim();
    expect(() => JSON.parse(out)).not.toThrow();
    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
  });

  it("appliances returns JSON when API succeeds", async () => {
    const { stdout, code } = await execCli(["appliances"]);
    if (code !== 0) return; // API can return invalid JSON for some accounts
    const out = stdout.trim();
    expect(() => JSON.parse(out)).not.toThrow();
    const data = JSON.parse(out);
    expect(Array.isArray(data) || typeof data === "object").toBe(true);
  });

  it("routines returns JSON", async () => {
    const { stdout, code } = await execCli(["routines"]);
    expect(code).toBe(0);
    const out = stdout.trim();
    expect(() => JSON.parse(out)).not.toThrow();
    const arr = JSON.parse(out);
    expect(Array.isArray(arr)).toBe(true);
  });

  it("unknown command exits non-zero", async () => {
    const { code } = await execCli(["unknown-command"]);
    expect(code).not.toBe(0);
  });

  it("--help shows usage", async () => {
    const { stdout, stderr, code } = await execCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout + stderr).toContain("Usage:");
    expect(stdout + stderr).toContain("auth");
    expect(stdout + stderr).toContain("devices");
  });
});
