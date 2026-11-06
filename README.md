# alexa-cli

LLM-first command-line control for Alexa/Echo and smart home devices using the unofficial Alexa app API.

`alexa-cli` is designed to be:
- **Predictable**: stable command grammar and stable JSON envelopes
- **Safe**: explicit dry-run support for mutating/broad commands
- **Automation-friendly**: non-interactive-safe auth defaults and useful exit codes
- **Human-usable**: concise `--human` output and thorough help

## Install

```bash
npm install -g alexa-cli
```

## Quick Discovery (for humans and agents)

```bash
alexa-cli --help
alexa-cli auth --help
alexa-cli switch-group --help
```

All commands accept:
- `--output json|human` (default: `json`)
- `--json` (shortcut for JSON output)
- `--human` (shortcut for concise text output)
- `--compact` (compact JSON)

## Output Contract

JSON success envelope:

```json
{
  "ok": true,
  "code": "OK",
  "command": "devices",
  "data": {}
}
```

JSON partial-success envelope:

```json
{
  "ok": true,
  "code": "PARTIAL",
  "command": "switch-group",
  "data": {}
}
```

JSON error envelope:

```json
{
  "ok": false,
  "code": "NOT_FOUND",
  "command": "status",
  "message": "Smart home device not found: \"Kitchen Lamp\".",
  "exitCode": 11
}
```

## Exit Codes

- `0` success
- `2` usage/validation error
- `10` auth missing/invalid
- `11` target not found
- `12` ambiguous match
- `20` partial success (some targets failed)
- `30` API/runtime error
- `99` internal error

## Authentication

### Non-interactive safe default (recommended)

```bash
alexa-cli auth login --token "Atnr|..." --domain amazon.co.uk
```

Or from file:

```bash
alexa-cli auth login --token-file ~/.secrets/alexa-token.txt
```

### Interactive browser flow (opt-in only)

```bash
alexa-cli auth login --interactive --domain amazon.co.uk
```

### Status / logout

```bash
alexa-cli auth status
alexa-cli auth status --verify
alexa-cli auth logout
```

## Capability Map

- **Discovery**
  - `devices`
  - `appliances [--type light|switch|plug|sensor|camera]`
  - `groups`
  - `group-members <group>`
  - `status <device-name>`
- **Voice**
  - `speak [text] --device <echo>`
  - `announce [text]`
  - `command [text] --device <echo>`
- **Smart home control**
  - `rename <old-name> <new-name> [--endpoint-id <id>] [--dry-run]`
  - `switch <name> <on|off> [--device <echo>]`
  - `switch-group <group> <on|off> [--all] [--include-unresolved] [--dry-run]`
  - `switch-room <pattern> <on|off> [--dry-run]`
  - `control <entityId> <turnOn|turnOff|setBrightness|setColorTemperature>`
  - `batch-control <action> [entityIds...] [--stdin auto|lines|json] [--dry-run]`
- **Routines**
  - `routines`
  - `run [automationId] | --name <name> | --partial <text> [--dry-run]`
- **Media**
  - `now-playing --device <echo>`
  - `media <play|pause|resume|stop|next|previous> --device <echo> [--dry-run]`
  - `volume [level] --device <echo> [--dry-run]`
- **Lighting-specific**
  - `brightness [level] --name <device> [--dry-run]`
  - `color-temp [kelvin] --name <device> [--dry-run]`

## Safety Patterns for Agents

1. **Discover first**:
   - `devices`, `appliances`, `groups`, `group-members`
2. **Dry-run before broad writes**:
   - `rename "Old name" "New name" --dry-run`
   - `switch-group ... --dry-run`
   - `switch-room ... --dry-run`
   - `batch-control ... --dry-run`
3. **Handle ambiguity explicitly**:
   - exit code `12` includes suggestions
4. **Treat partial as non-success**:
   - exit code `20` means some targets failed

## JSON Examples

### Device inventory

```bash
alexa-cli devices --json
```

```json
{
  "ok": true,
  "code": "OK",
  "command": "devices",
  "data": {
    "devices": [
      {
        "accountName": "Office Echo",
        "serialNumber": "G090...",
        "deviceType": "A1RAB...",
        "deviceOwnerCustomerId": "A2..."
      }
    ],
    "count": 1
  }
}
```

### Dry-run a group switch

```bash
alexa-cli switch-group Kitchen off --dry-run --json
```

```json
{
  "ok": true,
  "code": "OK",
  "command": "switch-group",
  "data": {
    "group": "Kitchen",
    "action": "turnOff",
    "dryRun": true,
    "planned": [
      { "name": "Kitchen spot 1", "endpointId": "amzn1.alexa.endpoint....", "resolved": true }
    ]
  }
}
```

### Batch IDs from stdin

```bash
printf "amzn1.alexa.endpoint.a\namzn1.alexa.endpoint.b\n" | alexa-cli batch-control turnOff --stdin lines --json
```

## Development

```bash
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run verify
```

## Requirements

- Node.js 18+
- Alexa account on `amazon.co.uk`, `amazon.com`, or `amazon.de`

## License

MIT
