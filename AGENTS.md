# AGENTS.md

This file provides guidance to AI agents when working with code in this repository.

## Project Overview

LLM-first CLI for controlling Alexa/Echo devices and smart home appliances via the unofficial Alexa app API. Supports UK (amazon.co.uk), US (amazon.com), and DE (amazon.de) regions.

## Commands

```bash
npm run build          # Compile TypeScript to dist/
npm run typecheck      # TypeScript no-emit validation
npm test               # Run unit tests (vitest)
npm run test:watch     # Run tests in watch mode
npm run test:integration  # Integration tests (requires ALEXA_REFRESH_TOKEN)
npm run test:e2e       # E2E CLI tests (requires auth via `alexa-cli auth login`)
npm run test:e2e:devices  # E2E device-specific tests
npm run lint           # Run ESLint
npm run lint:fix       # Fix ESLint issues automatically
npm run verify         # Lint + typecheck + tests + build
```

Run a single test file:
```bash
npx vitest run test/e2e.test.ts
npx vitest run test/e2e-devices.test.ts
```

## Architecture

**Entry points:**
- `src/cli.ts` - CLI entrypoint and command grammar

**Core modules:**
- `src/client.ts` - `AlexaClient` class with all API methods (devices, appliances, routines, media, smart home control)
- `src/cli-output.ts` - Stable JSON/human envelopes for command results and errors
- `src/errors.ts` - Typed CLI errors and code mapping
- `src/exit-codes.ts` - Stable process exit code contract
- `src/auth.ts` - Token exchange (refresh token → cookies) and CSRF extraction
- `src/auth-flow.ts` - Browser-based authentication flow with tunnel support
- `src/config.ts` - Region configs (domain, API base URLs, locale, cookie suffix)
- `src/config-store.ts` - Config persistence (~/.alexa-cli/config.json, with legacy fallback)
- `src/tunnel.ts` - Tunnel utilities for authentication (cloudflared, localtunnel)

**API patterns:**
- All requests go to app API (eu-api-alexa.amazon.co.uk or na-api-alexa.amazon.com)
- Auth: Cookie + `csrf` header (from /api/language Set-Cookie)
- Smart home control uses GraphQL at `/nexus/v1/graphql` with `amzn1.alexa.endpoint.*` IDs
- Some appliance control uses PUT `/api/phoenix/state` for non-GraphQL entity IDs

**Key types:**
- `Device` - Echo devices (accountName, serialNumber, deviceType, deviceOwnerCustomerId)
- `Appliance` - Smart home devices (entityId, endpointId, friendlyName)
- `Routine` - Alexa routines (automationId, name, sequence)

## Testing

Tests use vitest with globals enabled. Integration/E2E tests are skipped unless `TEST_INTEGRATION=1` is set.

Integration tests require a valid refresh token (set `ALEXA_REFRESH_TOKEN` env var or run `alexa-cli auth login` first).

Test files:
- `test/auth.test.ts` - Authentication logic tests
- `test/client.test.ts` - AlexaClient unit tests
- `test/integration.test.ts` - Integration tests (live API calls)
- `test/e2e.test.ts` - End-to-end CLI tests
- `test/e2e-devices.test.ts` - Device-specific E2E tests
- `test/e2e-harness.ts` - Test utilities for E2E tests

## Working Guidelines

### Conventional Commits

Use conventional commit format:
```
<type>[optional scope]: <description>

[optional body]

[optional footer(s)]
```

**Types:**
- `feat` - New feature
- `fix` - Bug fix
- `docs` - Documentation
- `style` - Code style (formatting, etc.)
- `refactor` - Code refactoring
- `test` - Adding or updating tests
- `chore` - Build process, dependencies, etc.

**Examples:**
```
feat(cli): add device group control support
fix(auth): handle token expiration gracefully
docs(api): update authentication flow documentation
test(e2e): add coverage for smart home routines
```

### One-Liner Philosophy

Prefer concise, focused one-line commits for simple changes:
```
fix: correct device name resolution
test: add missing unit test
docs: update installation instructions
```

Use multi-line commits only when additional context is necessary for complex changes.

### Code Style

- Use TypeScript strict mode
- Follow ESLint configuration (run `npm run lint:fix` before commits)
- Keep functions focused and small
- Use descriptive variable names
- Add JSDoc comments for public APIs
- Prefer async/await over Promise chains

### Development Workflow

1. Create feature branch from main
2. Make changes with conventional commits
3. Run `npm run lint` and `npm test` 
4. For integration testing: set `TEST_INTEGRATION=1` and ensure auth is configured
5. Submit PR with clear concise description

## API Reference

See `docs/API.md` for unofficial API details including endpoints, request/response shapes, and authentication notes.
