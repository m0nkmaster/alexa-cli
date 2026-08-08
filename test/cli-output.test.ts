import { afterEach, describe, expect, it, vi } from "vitest";
import { emitFailure, emitSuccess, wantsJson } from "../src/cli-output.js";
import { EXIT_CODES } from "../src/exit-codes.js";

describe("cli output contract", () => {
  const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
  const err = vi.spyOn(console, "error").mockImplementation(() => undefined);

  afterEach(() => {
    log.mockClear();
    err.mockClear();
  });

  it("emits success envelope in json mode", () => {
    emitSuccess("devices", { count: 2 }, { format: "json", pretty: true });
    const payload = JSON.parse(String(log.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload.ok).toBe(true);
    expect(payload.code).toBe("OK");
    expect(payload.command).toBe("devices");
  });

  it("emits concise line in human mode", () => {
    emitSuccess("devices", { count: 2 }, { format: "human", pretty: true }, "2 devices");
    expect(log).toHaveBeenCalledWith("2 devices");
  });

  it("emits error envelope in json mode", () => {
    emitFailure(
      "status",
      "NOT_FOUND",
      "Smart home device not found.",
      EXIT_CODES.NOT_FOUND,
      { format: "json", pretty: true },
      { query: "Kitchen" }
    );
    const payload = JSON.parse(String(log.mock.calls[0][0])) as Record<string, unknown>;
    expect(payload.ok).toBe(false);
    expect(payload.code).toBe("NOT_FOUND");
    expect(payload.exitCode).toBe(EXIT_CODES.NOT_FOUND);
  });

  it("chooses output mode deterministically", () => {
    expect(wantsJson({ output: "human" }, "json")).toBe(false);
    expect(wantsJson({ json: true }, "human")).toBe(true);
    expect(wantsJson({}, "json")).toBe(true);
  });
});
