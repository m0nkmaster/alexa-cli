import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach } from "vitest";

/** Point device cache at an isolated temp file for the current describe block. */
export function useIsolatedDevicesCache(): void {
  let cacheDir: string;
  let previousCachePath: string | undefined;

  beforeEach(() => {
    cacheDir = mkdtempSync(join(tmpdir(), "alexa-cli-cache-"));
    previousCachePath = process.env.ALEXA_DEVICES_CACHE_PATH;
    process.env.ALEXA_DEVICES_CACHE_PATH = join(cacheDir, "devices-cache.json");
  });

  afterEach(() => {
    if (previousCachePath === undefined) {
      delete process.env.ALEXA_DEVICES_CACHE_PATH;
    } else {
      process.env.ALEXA_DEVICES_CACHE_PATH = previousCachePath;
    }
    rmSync(cacheDir, { recursive: true, force: true });
  });
}
