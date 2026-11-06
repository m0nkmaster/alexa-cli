import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { Domain } from "./config.js";

/** Shared short TTL for smart-home discovery caches. */
export const DEVICES_CACHE_TTL_MS = 45_000;

const CACHE_VERSION = 2 as const;
const DEFAULT_CACHE_PATH = join(homedir(), ".alexa-cli", "devices-cache.json");

export interface CachedAppliance {
  entityId: string;
  endpointId?: string;
  friendlyName: string;
  isReachable: boolean;
  capabilities?: string[];
}

export interface AppliancesCacheEntry {
  appliances: CachedAppliance[];
  expiresAt: number;
}

interface DomainCache {
  appliances?: AppliancesCacheEntry;
}

interface DevicesCacheFile {
  version: typeof CACHE_VERSION;
  entries: Partial<Record<Domain, DomainCache>>;
}

function getCachePath(): string {
  return process.env.ALEXA_DEVICES_CACHE_PATH ?? DEFAULT_CACHE_PATH;
}

function ensureCacheDir(path: string): void {
  const dir = dirname(path);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  try {
    chmodSync(dir, 0o700);
  } catch {
    // Best-effort on platforms that restrict chmod.
  }
}

function toCachedAppliances(appliances: CachedAppliance[]): CachedAppliance[] {
  return appliances.map((a) => ({
    entityId: a.entityId,
    endpointId: a.endpointId,
    friendlyName: a.friendlyName,
    isReachable: a.isReachable,
    ...(a.capabilities ? { capabilities: [...a.capabilities] } : {}),
  }));
}

function isValidAppliancesEntry(value: unknown): value is AppliancesCacheEntry {
  if (!value || typeof value !== "object") return false;
  const entry = value as AppliancesCacheEntry;
  if (!Array.isArray(entry.appliances) || typeof entry.expiresAt !== "number") return false;
  return entry.appliances.every(
    (a) =>
      typeof a === "object" &&
      a !== null &&
      typeof a.entityId === "string" &&
      typeof a.friendlyName === "string" &&
      typeof a.isReachable === "boolean" &&
      (a.endpointId === undefined || typeof a.endpointId === "string") &&
      (a.capabilities === undefined ||
        (Array.isArray(a.capabilities) && a.capabilities.every((c) => typeof c === "string")))
  );
}

function readCacheFile(): DevicesCacheFile | null {
  const path = getCachePath();
  if (!existsSync(path)) return null;
  try {
    const parsed = JSON.parse(readFileSync(path, "utf-8")) as unknown;
    if (
      !parsed ||
      typeof parsed !== "object" ||
      (parsed as DevicesCacheFile).version !== CACHE_VERSION ||
      typeof (parsed as DevicesCacheFile).entries !== "object" ||
      (parsed as DevicesCacheFile).entries === null
    ) {
      return null;
    }
    return parsed as DevicesCacheFile;
  } catch {
    return null;
  }
}

function writeCacheFile(file: DevicesCacheFile): void {
  const path = getCachePath();
  ensureCacheDir(path);
  const tmpPath = `${path}.tmp`;
  writeFileSync(tmpPath, JSON.stringify(file), { encoding: "utf-8", mode: 0o600 });
  renameSync(tmpPath, path);
  try {
    chmodSync(path, 0o600);
  } catch {
    // Best-effort on platforms that restrict chmod.
  }
}

function persistDomainUpdate(domain: Domain, update: (entry: DomainCache) => void): void {
  try {
    const file = readCacheFile() ?? { version: CACHE_VERSION, entries: {} };
    const entry = { ...file.entries[domain] };
    update(entry);
    if (Object.keys(entry).length === 0) delete file.entries[domain];
    else file.entries[domain] = entry;
    const path = getCachePath();
    if (Object.keys(file.entries).length === 0) {
      if (existsSync(path)) unlinkSync(path);
      return;
    }
    writeCacheFile(file);
  } catch {
    // Cache write failures must not break commands.
  }
}

export function readAppliancesCache(domain: Domain): AppliancesCacheEntry | null {
  const entry = readCacheFile()?.entries[domain]?.appliances;
  if (!isValidAppliancesEntry(entry) || Date.now() >= entry.expiresAt) return null;
  return entry;
}

export function writeAppliancesCache(
  domain: Domain,
  appliances: CachedAppliance[],
  expiresAt: number
): void {
  persistDomainUpdate(domain, (entry) => {
    entry.appliances = { appliances: toCachedAppliances(appliances), expiresAt };
  });
}

export function clearSmartHomeCache(domain: Domain): void {
  persistDomainUpdate(domain, (entry) => {
    delete entry.appliances;
  });
}

/** Test helper: resolved cache file path. */
export function getDevicesCachePath(): string {
  return getCachePath();
}
