import type { CliErrorCode } from "./errors.js";
import type { ExitCode } from "./exit-codes.js";

export type OutputFormat = "json" | "human";

export interface OutputMode {
  format: OutputFormat;
  pretty?: boolean;
}

export interface SuccessEnvelope {
  ok: true;
  code: "OK" | "PARTIAL";
  command: string;
  data: unknown;
  meta?: Record<string, unknown>;
}

export interface ErrorEnvelope {
  ok: false;
  code: CliErrorCode;
  command: string;
  message: string;
  details?: Record<string, unknown>;
  exitCode: ExitCode;
}

function printJson(payload: unknown, pretty = true): void {
  console.log(JSON.stringify(payload, null, pretty ? 2 : 0));
}

export function emitSuccess(
  command: string,
  data: unknown,
  opts: OutputMode,
  humanLine?: string,
  code: "OK" | "PARTIAL" = "OK",
  meta?: Record<string, unknown>
): void {
  if (opts.format === "human" && humanLine) {
    console.log(humanLine);
    return;
  }
  const payload: SuccessEnvelope = {
    ok: true,
    code,
    command,
    data,
    ...(meta ? { meta } : {}),
  };
  printJson(payload, opts.pretty ?? true);
}

export function emitFailure(
  command: string,
  code: CliErrorCode,
  message: string,
  exitCode: ExitCode,
  opts: OutputMode,
  details?: Record<string, unknown>
): void {
  if (opts.format === "human") {
    console.error(message);
    return;
  }
  const payload: ErrorEnvelope = {
    ok: false,
    code,
    command,
    message,
    exitCode,
    ...(details ? { details } : {}),
  };
  printJson(payload, opts.pretty ?? true);
}

export function wantsJson(
  opts: { json?: boolean; human?: boolean; output?: string },
  globalOutput?: string
): boolean {
  if (opts.human) return false;
  if (opts.json) return true;
  if (opts.output) return opts.output === "json";
  return (globalOutput ?? "json") === "json";
}
