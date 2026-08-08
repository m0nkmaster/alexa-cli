import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { execCli } from "./e2e-harness.js";

describe("cli contract", () => {
  it("--help is discoverable and explicit", async () => {
    const { stdout, code } = await execCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Result envelope");
    expect(stdout).toContain("Exit codes");
  });

  it("returns stable usage envelope for auth login without token", async () => {
    const { stdout, code } = await execCli(["auth", "login"]);
    expect(code).toBe(2);
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("USAGE_ERROR");
    expect(out.exitCode).toBe(2);
  });

  it("returns stable parser envelope for unknown commands", async () => {
    const { stdout, code } = await execCli(["not-a-command"]);
    expect(code).toBe(2);
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("USAGE_ERROR");
  });

  it("returns auth envelope when credentials are missing", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "alexa-cli-contract-"));
    const { stdout, code } = await execCli(["devices"], {
      env: {
        HOME: isolatedHome,
        ALEXA_REFRESH_TOKEN: "",
      },
    });
    expect(code).toBe(10);
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("AUTH_REQUIRED");
    expect(out.exitCode).toBe(10);
  });

  it("fails fast when batch-control gets no IDs", async () => {
    const { stdout, code } = await execCli(["batch-control", "turnOff"], {
      env: {
        ALEXA_REFRESH_TOKEN: "Atnr|test",
        ALEXA_DOMAIN: "amazon.co.uk",
      },
    });
    expect(code).toBe(2);
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.ok).toBe(false);
    expect(out.code).toBe("USAGE_ERROR");
  });

  it("keeps JSON as the default output contract", async () => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "alexa-cli-contract-"));
    const { stdout, code } = await execCli(["auth", "status"], {
      env: { HOME: isolatedHome, ALEXA_REFRESH_TOKEN: "" },
    });
    expect(code).toBe(0);
    const out = JSON.parse(stdout.trim()) as Record<string, unknown>;
    expect(out.ok).toBe(true);
    expect(out.command).toBe("auth.status");
  });

  it.each([
    ["after nested subcommand", ["auth", "status", "--human"]],
    ["before nested subcommand chain", ["--human", "auth", "status"]],
    ["between nested auth subcommands", ["auth", "--human", "status"]],
  ])("accepts --human %s", async (_placement, args) => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "alexa-cli-contract-"));
    const { stdout, code } = await execCli(args, {
      env: { HOME: isolatedHome, ALEXA_REFRESH_TOKEN: "" },
    });
    expect(code).toBe(0);
    expect(stdout.trim()).toBe("Not configured.");
  });

  it.each([
    ["after nested subcommand", ["auth", "status", "--compact"]],
    ["before nested subcommand chain", ["--compact", "auth", "status"]],
    ["between nested auth subcommands", ["auth", "--compact", "status"]],
  ])("accepts --compact %s", async (_placement, args) => {
    const isolatedHome = mkdtempSync(join(tmpdir(), "alexa-cli-contract-"));
    const { stdout, code } = await execCli(args, {
      env: { HOME: isolatedHome, ALEXA_REFRESH_TOKEN: "" },
    });
    expect(code).toBe(0);
    expect(stdout).toContain('{"ok":true,');
    expect(stdout).not.toContain('\n  "ok"');
  });
});
