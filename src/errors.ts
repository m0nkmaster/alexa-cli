import type { ExitCode } from "./exit-codes.js";
import { EXIT_CODES } from "./exit-codes.js";

export type CliErrorCode =
  | "USAGE_ERROR"
  | "AUTH_REQUIRED"
  | "NOT_FOUND"
  | "AMBIGUOUS_MATCH"
  | "API_ERROR"
  | "INTERNAL_ERROR";

export class CliError extends Error {
  readonly code: CliErrorCode;
  readonly exitCode: ExitCode;
  readonly details?: Record<string, unknown>;

  constructor(
    code: CliErrorCode,
    message: string,
    options?: {
      exitCode?: ExitCode;
      details?: Record<string, unknown>;
      cause?: unknown;
    }
  ) {
    super(message, options?.cause ? { cause: options.cause } : undefined);
    this.name = "CliError";
    this.code = code;
    this.exitCode = options?.exitCode ?? EXIT_CODES.INTERNAL;
    this.details = options?.details;
  }
}
