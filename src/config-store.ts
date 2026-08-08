import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { AlexaCliConfig, Domain } from "./config.js";

const CONFIG_DIR = join(homedir(), ".alexa-cli");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const LEGACY_MCP_PATH = join(homedir(), ".alexa-mcp", "config.json");

export function loadConfig(): AlexaCliConfig | null {
  const env = process.env.ALEXA_REFRESH_TOKEN;
  if (env) {
    const domain = (process.env.ALEXA_DOMAIN || "amazon.co.uk") as Domain;
    return { refreshToken: env, domain };
  }
  for (const path of [CONFIG_PATH, LEGACY_MCP_PATH]) {
    if (!existsSync(path)) continue;
    try {
      const data = JSON.parse(readFileSync(path, "utf-8"));
      const token = data.refresh_token ?? data.refreshToken;
      if (!token) continue;
      const domain = (data.amazonDomain ?? data.domain ?? "amazon.co.uk") as Domain;
      return { refreshToken: token, domain };
    } catch {
      continue;
    }
  }
  return null;
}

export function saveConfig(config: AlexaCliConfig): void {
  if (!existsSync(CONFIG_DIR)) mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(
    CONFIG_PATH,
    JSON.stringify(
      { refreshToken: config.refreshToken, domain: config.domain },
      null,
      2
    )
  );
}

export function deleteConfig(): boolean {
  if (!existsSync(CONFIG_PATH)) return false;
  unlinkSync(CONFIG_PATH);
  return true;
}

export function getConfigPath(): string {
  return CONFIG_PATH;
}
