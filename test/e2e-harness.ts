import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const __dirname = dirname(fileURLToPath(import.meta.url));
const cliPath = join(__dirname, "../src/cli.ts");

export interface ExecCliResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

/**
 * Run the alexa-cli from source using tsx loader.
 */
export function execCli(
  args: string[],
  options?: { stdin?: string; env?: Record<string, string | undefined> }
): Promise<ExecCliResult> {
  return new Promise((resolve) => {
    const proc = spawn("node", ["--import", "tsx", cliPath, ...args], {
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env, ...(options?.env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    proc.stdout?.on("data", (chunk: Buffer) => { stdout += chunk.toString(); });
    proc.stderr?.on("data", (chunk: Buffer) => { stderr += chunk.toString(); });
    if (options?.stdin !== undefined) {
      proc.stdin?.write(options.stdin);
    }
    proc.stdin?.end();
    proc.on("close", (code, signal) => {
      resolve({
        stdout,
        stderr,
        code: code ?? (signal ? -1 : 0),
      });
    });
    proc.on("error", (_err) => {
      resolve({ stdout, stderr, code: -1 });
    });
  });
}
