#!/usr/bin/env node
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { Command, CommanderError } from "commander";
import { AlexaClient, AmbiguousMatchError } from "./client.js";
import { runBrowserAuth } from "./auth-flow.js";
import { emitFailure, emitSuccess, type OutputMode, wantsJson } from "./cli-output.js";
import { loadConfig, saveConfig, deleteConfig, getConfigPath } from "./config-store.js";
import { CliError } from "./errors.js";
import { EXIT_CODES, type ExitCode } from "./exit-codes.js";

type Domain = "amazon.co.uk" | "amazon.com" | "amazon.de";
type CommandResult = {
  data: unknown;
  humanLine?: string;
  code?: "OK" | "PARTIAL";
  exitCode?: ExitCode;
  meta?: Record<string, unknown>;
};

type GlobalOpts = {
  output?: string;
  json?: boolean;
  human?: boolean;
  compact?: boolean;
};

const program = new Command();
const __dirname = dirname(fileURLToPath(import.meta.url));
const pkg = JSON.parse(readFileSync(join(__dirname, "..", "package.json"), "utf-8")) as {
  version?: string;
};

function resolveOutput(opts: Record<string, unknown>): OutputMode {
  const globalOpts = program.opts<GlobalOpts>();
  const globalOutputSource = program.getOptionValueSource("output");
  const globalOutput = globalOutputSource === "default" ? undefined : globalOpts.output;
  const globalJson = wantsJson(
    {
      output: typeof globalOutput === "string" ? globalOutput : undefined,
      json: globalOpts.json === true,
      human: globalOpts.human === true,
    },
    "json"
  );
  const json = wantsJson(
    {
      output: typeof opts.output === "string" ? opts.output : undefined,
      json: opts.json === true,
      human: opts.human === true,
    },
    globalJson ? "json" : "human"
  );
  const compact =
    opts.compact === true || (typeof opts.compact === "boolean" && opts.compact) || globalOpts.compact;
  return { format: json ? "json" : "human", pretty: !compact };
}

function authConfigOrThrow(): { refreshToken: string; domain: Domain } {
  const cfg = loadConfig();
  if (!cfg?.refreshToken) {
    throw new CliError("AUTH_REQUIRED", "No credentials found. Run `alexa-cli auth login` first.", {
      exitCode: EXIT_CODES.AUTH,
      details: {
        authHint:
          "For non-interactive use, run: alexa-cli auth login --token <refreshToken> [--domain <domain>]",
      },
    });
  }
  return {
    refreshToken: cfg.refreshToken,
    domain: cfg.domain as Domain,
  };
}

function asState(state: string): "on" | "off" {
  const normalized = state.toLowerCase();
  if (normalized !== "on" && normalized !== "off") {
    throw new CliError("USAGE_ERROR", "State must be 'on' or 'off'.", {
      exitCode: EXIT_CODES.USAGE,
      details: { state },
    });
  }
  return normalized;
}

function asAction(
  action: string
): "turnOn" | "turnOff" | "setBrightness" | "setColorTemperature" {
  const valid = ["turnOn", "turnOff", "setBrightness", "setColorTemperature"] as const;
  if (!valid.includes(action as (typeof valid)[number])) {
    throw new CliError(
      "USAGE_ERROR",
      `Action must be one of: ${valid.join(", ")}.`,
      {
        exitCode: EXIT_CODES.USAGE,
        details: { action, valid },
      }
    );
  }
  return action as (typeof valid)[number];
}

function parseNumberInRange(name: string, raw: string, min: number, max: number): number {
  const value = Number.parseInt(raw, 10);
  if (Number.isNaN(value) || value < min || value > max) {
    throw new CliError("USAGE_ERROR", `${name} must be an integer between ${min} and ${max}.`, {
      exitCode: EXIT_CODES.USAGE,
      details: { [name]: raw, min, max },
    });
  }
  return value;
}

async function resolveDeviceOrThrow(client: AlexaClient, query: string) {
  const device = await client.resolveDevice(query);
  if (!device) {
    throw new CliError("NOT_FOUND", `Echo device not found: "${query}".`, {
      exitCode: EXIT_CODES.NOT_FOUND,
      details: { query },
    });
  }
  return device;
}

async function resolveApplianceOrThrow(client: AlexaClient, query: string) {
  const app = await client.resolveApplianceByName(query);
  if (!app) {
    throw new CliError("NOT_FOUND", `Smart home device not found: "${query}".`, {
      exitCode: EXIT_CODES.NOT_FOUND,
      details: { query },
    });
  }
  return app;
}

async function readEntityIdsFromArgsOrStdin(
  args: string[],
  format: "auto" | "lines" | "json"
): Promise<string[]> {
  if (args.length > 0) return args;
  if (process.stdin.isTTY) return [];

  const input = await new Promise<string>((resolve, reject) => {
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => {
      data += chunk;
    });
    process.stdin.on("end", () => resolve(data.trim()));
    process.stdin.on("error", reject);
  });

  if (!input) return [];
  const parser = format === "auto" ? (input.trim().startsWith("[") ? "json" : "lines") : format;
  if (parser === "json") {
    try {
      const parsed = JSON.parse(input);
      if (!Array.isArray(parsed)) {
        throw new CliError("USAGE_ERROR", "When using JSON stdin, provide an array of entity IDs.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      return parsed.map((v) => String(v).trim()).filter(Boolean);
    } catch (error) {
      if (error instanceof CliError) throw error;
      throw new CliError("USAGE_ERROR", "Invalid JSON on stdin.", {
        exitCode: EXIT_CODES.USAGE,
        details: { inputPreview: input.slice(0, 80) },
        cause: error,
      });
    }
  }

  return input
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

async function runCommand(
  commandName: string,
  opts: Record<string, unknown>,
  task: () => Promise<CommandResult>
): Promise<void> {
  const output = resolveOutput(opts);
  try {
    const result = await task();
    emitSuccess(
      commandName,
      result.data,
      output,
      result.humanLine,
      result.code ?? "OK",
      result.meta
    );
    if (typeof result.exitCode === "number") process.exitCode = result.exitCode;
  } catch (error) {
    handleError(commandName, error, output);
  }
}

function handleError(commandName: string, error: unknown, output: OutputMode): never {
  if (error instanceof CliError) {
    emitFailure(commandName, error.code, error.message, error.exitCode, output, error.details);
    process.exit(error.exitCode);
  }
  if (error instanceof AmbiguousMatchError) {
    emitFailure(
      commandName,
      "AMBIGUOUS_MATCH",
      error.message,
      EXIT_CODES.AMBIGUOUS,
      output,
      { query: error.query, suggestions: error.suggestions }
    );
    process.exit(EXIT_CODES.AMBIGUOUS);
  }
  const message = error instanceof Error ? error.message : String(error);
  emitFailure(commandName, "API_ERROR", message, EXIT_CODES.API, output);
  process.exit(EXIT_CODES.API);
}

program
  .name("alexa-cli")
  .description("LLM-first Alexa CLI with stable JSON contracts and safe defaults")
  .version(pkg.version ?? "0.1.0")
  .showHelpAfterError()
  .showSuggestionAfterError()
  .option("--output <format>", "Output format: json | human", "json")
  .option("--json", "Shortcut for --output json")
  .option("--human", "Shortcut for --output human")
  .option("--compact", "Use compact JSON")
  .addHelpText(
    "after",
    `
Result envelope (JSON mode):
  success: { "ok": true, "code": "OK|PARTIAL", "command": "<name>", "data": { ... } }
  error:   { "ok": false, "code": "<error>", "command": "<name>", "message": "...", "exitCode": n }

Exit codes:
  0 success, 2 usage error, 10 auth error, 11 not found, 12 ambiguous match,
  20 partial success, 30 API error, 99 internal error`
  );

program.configureOutput({
  writeErr: () => undefined,
});
program.exitOverride();

const auth = program.command("auth").description("Authentication and credential management");

auth
  .command("login")
  .description("Authenticate using a refresh token (safe default) or browser flow with --interactive")
  .option("--token <token>", "Refresh token")
  .option("--token-file <path>", "Read refresh token from file")
  .option("--domain <domain>", "Amazon domain (amazon.co.uk | amazon.com | amazon.de)", "amazon.co.uk")
  .option("--interactive", "Use browser-based auth flow")
  .option("--no-save", "Validate only, do not save credentials")
  .action(async (opts) =>
    runCommand("auth.login", opts, async () => {
      const domain = (opts.domain || "amazon.co.uk") as Domain;
      const tokenFromFile = opts.tokenFile
        ? readFileSync(String(opts.tokenFile), "utf-8").trim()
        : undefined;
      const token = (opts.token ?? tokenFromFile ?? "").trim();

      let refreshToken = token;
      if (!refreshToken) {
        if (!opts.interactive) {
          throw new CliError(
            "USAGE_ERROR",
            "Provide --token/--token-file or explicitly opt in to browser flow with --interactive.",
            { exitCode: EXIT_CODES.USAGE }
          );
        }
        const flow = await runBrowserAuth(domain);
        refreshToken = flow.refreshToken;
      }

      const client = new AlexaClient({ refreshToken, domain });
      const devices = await client.getDevices();
      if (opts.save) saveConfig({ refreshToken, domain });

      return {
        data: {
          authenticated: true,
          saved: Boolean(opts.save),
          domain,
          deviceCount: devices.length,
          configPath: getConfigPath(),
        },
        humanLine: `Authenticated (${devices.length} devices).`,
      };
    })
  );

auth
  .command("status")
  .description("Show configured authentication status")
  .option("--verify", "Call Alexa API to verify the token")
  .action(async (opts) =>
    runCommand("auth.status", opts, async () => {
      const cfg = loadConfig();
      if (!cfg) {
        return {
          data: { configured: false },
          humanLine: "Not configured.",
        };
      }
      const masked =
        cfg.refreshToken.length > 8 ? `${cfg.refreshToken.slice(0, 8)}...` : cfg.refreshToken;
      if (!opts.verify) {
        return {
          data: {
            configured: true,
            domain: cfg.domain,
            tokenPreview: masked,
            configPath: getConfigPath(),
          },
          humanLine: `Configured for ${cfg.domain}.`,
        };
      }
      const client = new AlexaClient({
        refreshToken: cfg.refreshToken,
        domain: cfg.domain as Domain,
      });
      const devices = await client.getDevices();
      const owners = [...new Set(devices.map((d) => d.deviceOwnerCustomerId).filter(Boolean))];
      return {
        data: {
          configured: true,
          valid: true,
          domain: cfg.domain,
          tokenPreview: masked,
          configPath: getConfigPath(),
          deviceCount: devices.length,
          ownerIds: owners,
        },
        humanLine: `Valid token (${devices.length} devices).`,
      };
    })
  );

auth
  .command("logout")
  .description("Delete stored credentials")
  .action(async (opts) =>
    runCommand("auth.logout", opts, async () => {
      const removed = deleteConfig();
      return {
        data: { removed, configPath: getConfigPath() },
        humanLine: removed ? "Credentials removed." : "No credentials found.",
      };
    })
  );

program
  .command("devices")
  .description("List Echo devices")
  .option("--owners", "Return only accountName and owner IDs")
  .action(async (opts) =>
    runCommand("devices", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const devices = await client.getDevices();
      const data = opts.owners
        ? devices.map((d) => ({ accountName: d.accountName, deviceOwnerCustomerId: d.deviceOwnerCustomerId }))
        : devices;
      return {
        data: { devices: data, count: data.length },
        humanLine: `${data.length} devices`,
      };
    })
  );

program
  .command("appliances")
  .description("List smart home appliances")
  .option("--type <type>", "Filter by type: light | switch | plug | sensor | camera")
  .action(async (opts) =>
    runCommand("appliances", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      let appliances = await client.listAppliances();
      if (opts.type) {
        const type = String(opts.type).toLowerCase();
        appliances = appliances.filter((a) => {
          const caps = (a.capabilities ?? []).join(" ").toLowerCase();
          const name = (a.friendlyName ?? "").toLowerCase();
          switch (type) {
            case "light":
              return caps.includes("brightness") || caps.includes("colortemperature") || /light|lamp|bulb/.test(name);
            case "switch":
              return caps.includes("power") && !caps.includes("brightness");
            case "plug":
              return /plug/.test(name);
            case "sensor":
              return /sensor|motion|contact|temperature/.test(caps);
            case "camera":
              return /camera|doorbell/.test(name);
            default:
              return true;
          }
        });
      }
      return {
        data: { appliances, count: appliances.length },
        humanLine: `${appliances.length} appliances`,
      };
    })
  );

program
  .command("groups")
  .description("List Alexa room groups")
  .action(async (opts) =>
    runCommand("groups", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const groups = await client.listDeviceGroups();
      return { data: { groups, count: groups.length }, humanLine: `${groups.length} groups` };
    })
  );

program
  .command("group-members <group>")
  .description("List resolved and unresolved members of a room group")
  .action(async (group: string, opts) =>
    runCommand("group-members", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const result = await client.listGroupMembers(group);
      if (!result) {
        throw new CliError("NOT_FOUND", `No group matched "${group}".`, {
          exitCode: EXIT_CODES.NOT_FOUND,
          details: { group },
        });
      }
      return { data: result, humanLine: `${result.members.length} members in ${result.group}` };
    })
  );

program
  .command("status <name>")
  .description("Get current smart home device state by friendly name")
  .action(async (name: string, opts) =>
    runCommand("status", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const app = await resolveApplianceOrThrow(client, name);
      const endpointId = app.endpointId ?? app.entityId;
      const state = endpointId ? await client.getEndpointState(endpointId) : {};
      return {
        data: { friendlyName: app.friendlyName, endpointId, ...state },
        humanLine: `${app.friendlyName}: ${String((state as { powerState?: string }).powerState ?? "unknown")}`,
      };
    })
  );

program
  .command("switch-group <group> <state>")
  .description("Turn devices on/off in a room group")
  .option("--all", "Control all appliances, not just lights")
  .option("--include-unresolved", "Also attempt unresolved group member IDs")
  .option("--dry-run", "Plan only, no control calls")
  .action(async (group: string, state: string, opts) =>
    runCommand("switch-group", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const action = asState(state) === "on" ? "turnOn" : "turnOff";
      const result = await client.controlAppliancesByGroup(group, action, {
        lightsOnly: !opts.all,
        includeUnresolved: opts.includeUnresolved,
        dryRun: opts.dryRun,
      });
      const dryRun = Boolean(opts.dryRun);
      const plannedCount = result.planned?.length ?? 0;
      const controlledCount = result.controlled.length;
      const errorCount = result.errors.length;
      const exitCode = dryRun
        ? plannedCount > 0
          ? EXIT_CODES.OK
          : EXIT_CODES.NOT_FOUND
        : controlledCount > 0 && errorCount > 0
          ? EXIT_CODES.PARTIAL
          : controlledCount > 0
            ? EXIT_CODES.OK
            : EXIT_CODES.NOT_FOUND;
      return {
        data: { group, action, dryRun, ...result },
        humanLine: dryRun
          ? `Planned ${plannedCount} targets`
          : `Controlled ${controlledCount} targets (${errorCount} errors)`,
        code: exitCode === EXIT_CODES.PARTIAL ? "PARTIAL" : "OK",
        exitCode,
      };
    })
  );

program
  .command("switch-room <pattern> <state>")
  .description("Turn devices on/off by name pattern")
  .option("--dry-run", "Plan only, no control calls")
  .action(async (pattern: string, state: string, opts) =>
    runCommand("switch-room", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const action = asState(state) === "on" ? "turnOn" : "turnOff";
      const result = await client.controlAppliancesByPattern(pattern, action, { dryRun: opts.dryRun });
      const dryRun = Boolean(opts.dryRun);
      const plannedCount = result.planned?.length ?? 0;
      const controlledCount = result.controlled.length;
      const errorCount = result.errors.length;
      const exitCode = dryRun
        ? plannedCount > 0
          ? EXIT_CODES.OK
          : EXIT_CODES.NOT_FOUND
        : controlledCount > 0 && errorCount > 0
          ? EXIT_CODES.PARTIAL
          : controlledCount > 0
            ? EXIT_CODES.OK
            : EXIT_CODES.NOT_FOUND;
      return {
        data: { pattern, action, dryRun, ...result },
        humanLine: dryRun
          ? `Planned ${plannedCount} targets`
          : `Controlled ${controlledCount} targets (${errorCount} errors)`,
        code: exitCode === EXIT_CODES.PARTIAL ? "PARTIAL" : "OK",
        exitCode,
      };
    })
  );

program
  .command("batch-control <action> [entityIds...]")
  .description("Batch control appliances by IDs (args or stdin)")
  .option("--stdin <format>", "Read IDs from stdin: auto | lines | json", "auto")
  .option("--brightness <value>", "Brightness for setBrightness")
  .option("--kelvin <value>", "Kelvin for setColorTemperature")
  .option("--dry-run", "Plan only, no control calls")
  .action(async (action: string, entityIds: string[], opts) =>
    runCommand("batch-control", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const parsedAction = asAction(action);
      const ids = await readEntityIdsFromArgsOrStdin(entityIds, opts.stdin);
      if (ids.length === 0) {
        throw new CliError("USAGE_ERROR", "No entity IDs supplied (arguments or stdin).", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      const brightness = opts.brightness
        ? parseNumberInRange("brightness", String(opts.brightness), 0, 100)
        : undefined;
      const kelvin = opts.kelvin
        ? parseNumberInRange("kelvin", String(opts.kelvin), 2000, 6500)
        : undefined;
      if (parsedAction === "setBrightness" && brightness === undefined) {
        throw new CliError("USAGE_ERROR", "--brightness is required for setBrightness.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (parsedAction === "setColorTemperature" && kelvin === undefined) {
        throw new CliError("USAGE_ERROR", "--kelvin is required for setColorTemperature.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }

      if (opts.dryRun) {
        return {
          data: { action: parsedAction, dryRun: true, planned: ids },
          humanLine: `Planned ${ids.length} targets`,
        };
      }

      const results = await client.batchControlAppliances(ids, parsedAction, brightness, kelvin);
      const successCount = results.filter((r) => r.success).length;
      const errorCount = results.length - successCount;
      const exitCode =
        successCount > 0 && errorCount > 0
          ? EXIT_CODES.PARTIAL
          : successCount > 0
            ? EXIT_CODES.OK
            : EXIT_CODES.API;
      return {
        data: {
          action: parsedAction,
          results,
          successCount,
          errorCount,
        },
        code: exitCode === EXIT_CODES.PARTIAL ? "PARTIAL" : "OK",
        exitCode,
        humanLine: `Controlled ${successCount}/${results.length} targets`,
      };
    })
  );

program
  .command("speak [text]")
  .description("Speak text on one Echo device")
  .option("--text <value>", "Text to speak (alternative to positional argument)")
  .option("--device <name>", "Echo device name")
  .option("--dry-run", "Plan only, no control call")
  .action(async (textArg: string | undefined, opts) =>
    runCommand("speak", opts, async () => {
      const cfg = authConfigOrThrow();
      const text = String(opts.text ?? textArg ?? "").trim();
      if (!text) {
        throw new CliError("USAGE_ERROR", "Provide text as positional argument or --text.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (!opts.device) {
        throw new CliError("USAGE_ERROR", "--device is required.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      const client = new AlexaClient(cfg);
      const device = await resolveDeviceOrThrow(client, String(opts.device));
      if (opts.dryRun) {
        return {
          data: { action: "speak", dryRun: true, device: device.accountName, text },
          humanLine: `Would speak on ${device.accountName}`,
        };
      }
      await client.speak(device.serialNumber, device.deviceType, device.deviceOwnerCustomerId, text);
      return {
        data: { action: "speak", device: device.accountName, text },
        humanLine: `Spoke on ${device.accountName}`,
      };
    })
  );

program
  .command("announce [text]")
  .description("Broadcast announcement to all Echo devices")
  .option("--text <value>", "Announcement text (alternative to positional argument)")
  .option("--dry-run", "Plan only, no control call")
  .action(async (textArg: string | undefined, opts) =>
    runCommand("announce", opts, async () => {
      const cfg = authConfigOrThrow();
      const text = String(opts.text ?? textArg ?? "").trim();
      if (!text) {
        throw new CliError("USAGE_ERROR", "Provide text as positional argument or --text.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      const client = new AlexaClient(cfg);
      const devices = await client.getDevices();
      if (devices.length === 0) {
        throw new CliError("NOT_FOUND", "No Echo devices found for this account.", {
          exitCode: EXIT_CODES.NOT_FOUND,
        });
      }
      if (opts.dryRun) {
        return {
          data: { action: "announce", dryRun: true, scope: "all_devices", text, deviceCount: devices.length },
          humanLine: `Would announce to ${devices.length} devices`,
        };
      }
      await client.announce(devices[0].deviceOwnerCustomerId, text);
      return {
        data: { action: "announce", scope: "all_devices", text, deviceCount: devices.length },
        humanLine: `Announcement sent to ${devices.length} devices`,
      };
    })
  );

program
  .command("command [text]")
  .description("Send a voice command to one Echo device")
  .option("--text <value>", "Command text (alternative to positional argument)")
  .option("--device <name>", "Echo device name")
  .option("--dry-run", "Plan only, no control call")
  .action(async (textArg: string | undefined, opts) =>
    runCommand("command", opts, async () => {
      const cfg = authConfigOrThrow();
      const text = String(opts.text ?? textArg ?? "").trim();
      if (!text) {
        throw new CliError("USAGE_ERROR", "Provide text as positional argument or --text.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (!opts.device) {
        throw new CliError("USAGE_ERROR", "--device is required.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      const client = new AlexaClient(cfg);
      const device = await resolveDeviceOrThrow(client, String(opts.device));
      if (opts.dryRun) {
        return {
          data: { action: "command", dryRun: true, device: device.accountName, text },
          humanLine: `Would send command to ${device.accountName}`,
        };
      }
      await client.command(device.serialNumber, device.deviceType, device.deviceOwnerCustomerId, text);
      return {
        data: { action: "command", device: device.accountName, text },
        humanLine: `Command sent to ${device.accountName}`,
      };
    })
  );

program
  .command("switch <name> <state>")
  .description("Turn one smart home device on or off by friendly name")
  .option("--device <echo>", "Echo for voice fallback if direct control fails")
  .option("--dry-run", "Plan only, no control call")
  .action(async (name: string, state: string, opts) =>
    runCommand("switch", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const action = asState(state) === "on" ? "turnOn" : "turnOff";
      const app = await resolveApplianceOrThrow(client, name);
      const endpointId = app.endpointId ?? app.entityId;

      if (opts.dryRun) {
        return {
          data: { action, dryRun: true, target: app.friendlyName, endpointId },
          humanLine: `Would ${action} ${app.friendlyName}`,
        };
      }

      if (app.endpointId) {
        await client.controlAppliance(app.endpointId, action);
        const live = await client.getEndpointState(app.endpointId);
        return {
          data: { action, target: app.friendlyName, endpointId: app.endpointId, method: "direct", ...live },
          humanLine: `${action} ${app.friendlyName}`,
        };
      }

      if (!opts.device) {
        throw new CliError(
          "USAGE_ERROR",
          "Direct endpoint is unavailable for this device. Provide --device for voice fallback.",
          { exitCode: EXIT_CODES.USAGE, details: { name } }
        );
      }
      const echo = await resolveDeviceOrThrow(client, String(opts.device));
      const phrase = action === "turnOn" ? `turn on ${name}` : `turn off ${name}`;
      await client.command(echo.serialNumber, echo.deviceType, echo.deviceOwnerCustomerId, phrase);
      return {
        data: { action, target: name, method: "voice", via: echo.accountName, phrase },
        humanLine: `${action} ${name} via ${echo.accountName}`,
      };
    })
  );

program
  .command("control <entityId> <action>")
  .description("Control one appliance by endpoint/entity ID")
  .option("--brightness <value>", "Brightness 0-100 for setBrightness")
  .option("--kelvin <value>", "Kelvin 2000-6500 for setColorTemperature")
  .option("--dry-run", "Plan only, no control call")
  .action(async (entityId: string, action: string, opts) =>
    runCommand("control", opts, async () => {
      const cfg = authConfigOrThrow();
      const parsedAction = asAction(action);
      const brightness = opts.brightness
        ? parseNumberInRange("brightness", String(opts.brightness), 0, 100)
        : undefined;
      const kelvin = opts.kelvin
        ? parseNumberInRange("kelvin", String(opts.kelvin), 2000, 6500)
        : undefined;
      if (parsedAction === "setBrightness" && brightness === undefined) {
        throw new CliError("USAGE_ERROR", "--brightness is required for setBrightness.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (parsedAction === "setColorTemperature" && kelvin === undefined) {
        throw new CliError("USAGE_ERROR", "--kelvin is required for setColorTemperature.", {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (opts.dryRun) {
        return {
          data: { entityId, action: parsedAction, brightness, kelvin, dryRun: true },
          humanLine: `Would run ${parsedAction} on ${entityId}`,
        };
      }
      const client = new AlexaClient(cfg);
      await client.controlAppliance(entityId, parsedAction, brightness, kelvin);
      const state = entityId.startsWith("amzn1.alexa.endpoint.")
        ? await client.getEndpointState(entityId)
        : {};
      return {
        data: { entityId, action: parsedAction, ...state },
        humanLine: `${parsedAction} applied`,
      };
    })
  );

program
  .command("routines")
  .description("List Alexa routines")
  .action(async (opts) =>
    runCommand("routines", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const routines = await client.listRoutines();
      return { data: { routines, count: routines.length }, humanLine: `${routines.length} routines` };
    })
  );

program
  .command("run [automationId]")
  .description("Run routine by ID, --name, or --partial")
  .option("--name <name>", "Exact routine name")
  .option("--partial <text>", "Partial routine name")
  .option("--dry-run", "Resolve only, no execution")
  .action(async (automationId: string | undefined, opts) =>
    runCommand("run", opts, async () => {
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const routines = await client.listRoutines();
      const modeCount = [automationId, opts.name, opts.partial].filter(Boolean).length;
      if (modeCount !== 1) {
        throw new CliError(
          "USAGE_ERROR",
          "Provide exactly one selector: automationId, --name, or --partial.",
          { exitCode: EXIT_CODES.USAGE }
        );
      }

      let selected = routines[0];
      if (automationId) {
        selected = routines.find((r) => r.automationId === automationId) as (typeof routines)[0];
      } else if (opts.name) {
        const query = String(opts.name).toLowerCase();
        selected = routines.find((r) => r.name.toLowerCase() === query) as (typeof routines)[0];
      } else if (opts.partial) {
        const query = String(opts.partial).toLowerCase();
        const matches = routines.filter((r) => r.name.toLowerCase().includes(query));
        if (matches.length > 1) {
          throw new CliError("AMBIGUOUS_MATCH", "Multiple routines matched partial query.", {
            exitCode: EXIT_CODES.AMBIGUOUS,
            details: { query, suggestions: matches.map((m) => m.name) },
          });
        }
        selected = matches[0];
      }
      if (!selected) {
        throw new CliError("NOT_FOUND", "Routine not found.", { exitCode: EXIT_CODES.NOT_FOUND });
      }
      if (opts.dryRun) {
        return {
          data: {
            dryRun: true,
            routine: { automationId: selected.automationId, name: selected.name },
          },
          humanLine: `Would run ${selected.name}`,
        };
      }
      const sequenceJson = selected.sequence != null ? JSON.stringify(selected.sequence) : undefined;
      await client.runRoutine(selected.automationId, sequenceJson);
      return {
        data: { ran: selected.name, automationId: selected.automationId },
        humanLine: `Ran ${selected.name}`,
      };
    })
  );

program
  .command("now-playing")
  .description("Show now-playing state for an Echo device")
  .option("--device <name>", "Echo device name")
  .action(async (opts) =>
    runCommand("now-playing", opts, async () => {
      if (!opts.device) {
        throw new CliError("USAGE_ERROR", "--device is required.", { exitCode: EXIT_CODES.USAGE });
      }
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const device = await resolveDeviceOrThrow(client, String(opts.device));
      const state = await client.getNowPlaying(device.serialNumber, device.deviceType);
      return {
        data: { device: device.accountName, ...state },
        humanLine: `Fetched now-playing for ${device.accountName}`,
      };
    })
  );

program
  .command("media <command>")
  .description("Send transport command: play|pause|resume|stop|next|previous")
  .option("--device <name>", "Echo device name")
  .option("--dry-run", "Plan only, no control call")
  .action(async (command: string, opts) =>
    runCommand("media", opts, async () => {
      const allowed = ["play", "pause", "resume", "stop", "next", "previous"];
      if (!allowed.includes(command.toLowerCase())) {
        throw new CliError("USAGE_ERROR", `Command must be one of: ${allowed.join(", ")}.`, {
          exitCode: EXIT_CODES.USAGE,
        });
      }
      if (!opts.device) {
        throw new CliError("USAGE_ERROR", "--device is required.", { exitCode: EXIT_CODES.USAGE });
      }
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const device = await resolveDeviceOrThrow(client, String(opts.device));
      if (opts.dryRun) {
        return {
          data: { command: command.toLowerCase(), device: device.accountName, dryRun: true },
          humanLine: `Would send ${command} to ${device.accountName}`,
        };
      }
      const nowPlaying = await client.getNowPlaying(device.serialNumber, device.deviceType);
      const taskSessionId = nowPlaying.taskSessionId;
      if (!taskSessionId) {
        throw new CliError("NOT_FOUND", "No active media session found on target device.", {
          exitCode: EXIT_CODES.NOT_FOUND,
          details: { device: device.accountName },
        });
      }
      await client.controlMediaSession(
        device,
        taskSessionId,
        command.toLowerCase() as "play" | "pause" | "resume" | "stop" | "next" | "previous"
      );
      return {
        data: { command: command.toLowerCase(), device: device.accountName },
        humanLine: `${command} sent to ${device.accountName}`,
      };
    })
  );

program
  .command("volume [level]")
  .description("Get or set Echo speaker volume (0-100)")
  .option("--device <name>", "Echo device name")
  .option("--dry-run", "Plan only for set operation")
  .action(async (level: string | undefined, opts) =>
    runCommand("volume", opts, async () => {
      if (!opts.device) {
        throw new CliError("USAGE_ERROR", "--device is required.", { exitCode: EXIT_CODES.USAGE });
      }
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const device = await resolveDeviceOrThrow(client, String(opts.device));
      if (!level) {
        const state = await client.getVolume(device.deviceType, device.serialNumber);
        return { data: { device: device.accountName, ...state }, humanLine: `Volume: ${state.volume}` };
      }
      const value = parseNumberInRange("volume", level, 0, 100);
      if (opts.dryRun) {
        return {
          data: { device: device.accountName, volume: value, dryRun: true },
          humanLine: `Would set volume to ${value}`,
        };
      }
      await client.setVolume(device.deviceType, device.serialNumber, value);
      return {
        data: { device: device.accountName, volume: value },
        humanLine: `Volume set to ${value}`,
      };
    })
  );

program
  .command("brightness [level]")
  .description("Get or set smart-light brightness by name")
  .option("--name <name>", "Smart home device name")
  .option("--dry-run", "Plan only for set operation")
  .action(async (level: string | undefined, opts) =>
    runCommand("brightness", opts, async () => {
      if (!opts.name) {
        throw new CliError("USAGE_ERROR", "--name is required.", { exitCode: EXIT_CODES.USAGE });
      }
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const app = await resolveApplianceOrThrow(client, String(opts.name));
      const endpointId = app.endpointId ?? app.entityId;
      if (!endpointId) {
        throw new CliError("NOT_FOUND", "Resolved device has no endpoint/entity ID.", {
          exitCode: EXIT_CODES.NOT_FOUND,
        });
      }
      if (!level) {
        const state = await client.getEndpointState(endpointId);
        return { data: { device: app.friendlyName, endpointId, ...state }, humanLine: `${app.friendlyName}` };
      }
      const value = parseNumberInRange("brightness", level, 0, 100);
      if (opts.dryRun) {
        return {
          data: { device: app.friendlyName, endpointId, brightness: value, dryRun: true },
          humanLine: `Would set brightness to ${value}%`,
        };
      }
      await client.controlAppliance(endpointId, "setBrightness", value);
      return {
        data: { device: app.friendlyName, endpointId, brightness: value },
        humanLine: `Brightness set to ${value}%`,
      };
    })
  );

program
  .command("color-temp [kelvin]")
  .description("Get or set smart-light colour temperature by name")
  .option("--name <name>", "Smart home device name")
  .option("--dry-run", "Plan only for set operation")
  .action(async (kelvin: string | undefined, opts) =>
    runCommand("color-temp", opts, async () => {
      if (!opts.name) {
        throw new CliError("USAGE_ERROR", "--name is required.", { exitCode: EXIT_CODES.USAGE });
      }
      const cfg = authConfigOrThrow();
      const client = new AlexaClient(cfg);
      const app = await resolveApplianceOrThrow(client, String(opts.name));
      const endpointId = app.endpointId ?? app.entityId;
      if (!endpointId) {
        throw new CliError("NOT_FOUND", "Resolved device has no endpoint/entity ID.", {
          exitCode: EXIT_CODES.NOT_FOUND,
        });
      }
      if (!kelvin) {
        const state = await client.getEndpointState(endpointId);
        return { data: { device: app.friendlyName, endpointId, ...state }, humanLine: `${app.friendlyName}` };
      }
      const value = parseNumberInRange("kelvin", kelvin, 2000, 6500);
      if (opts.dryRun) {
        return {
          data: { device: app.friendlyName, endpointId, colorTemperature: value, dryRun: true },
          humanLine: `Would set colour temperature to ${value}K`,
        };
      }
      await client.controlAppliance(endpointId, "setColorTemperature", undefined, value);
      return {
        data: { device: app.friendlyName, endpointId, colorTemperature: value },
        humanLine: `Colour temperature set to ${value}K`,
      };
    })
  );

program.parseAsync(process.argv).catch((error: unknown) => {
  if (error instanceof CommanderError) {
    if (error.code === "commander.helpDisplayed" || error.code === "commander.version") {
      process.exit(0);
    }
    const defaultOutput: OutputMode = { format: "json", pretty: true };
    emitFailure("cli", "USAGE_ERROR", error.message, EXIT_CODES.USAGE, defaultOutput);
    process.exit(EXIT_CODES.USAGE);
  }
  const defaultOutput: OutputMode = { format: "json", pretty: true };
  emitFailure("cli", "INTERNAL_ERROR", String(error), EXIT_CODES.INTERNAL, defaultOutput);
  process.exit(EXIT_CODES.INTERNAL);
});
