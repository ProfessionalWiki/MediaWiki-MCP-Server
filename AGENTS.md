# AGENTS.md

Project context for AI coding agents working on this repo. For human users, start from [README.md](README.md).

## Repo layout

- `src/tools/` — one file per non-extension MCP tool (descriptor + handler + registration).
- `src/tools/extensions/<id>/` — extension packs: tools gated on a specific MediaWiki extension (SMW / Bucket / Cargo / …), grouped under a per-pack module.
- `src/runtime/` — context, dispatcher, register, reconcile, logger, constants, request-scoped context, auth-shape classifier.
- `src/wikis/` — wiki registry, selection, mwn provider, discovery, error sanitiser.
- `src/transport/` — stdio and streamable HTTP entry points, SSRF/upload guards, low-level HTTP helpers.
- `src/auth/` — OAuth for MediaWiki, in two roles (client to a wiki, and the hosted authorization-server proxy). See [src/auth/README.md](src/auth/README.md).
- `src/config/` — `config.json` loader and substitution.
- `src/services/` — section, edit, revision, response services consumed via `ToolContext`.
- `src/results/` — response shaping (truncation, format, schemas).
- `src/errors/` — error classifier + per-tool special cases.
- `src/resources/` — MCP resources exposing `mcp://wikis/{wikiKey}`.
- `src/server.ts`, `src/index.ts` — server factory and bootstrap.
- `tests/` — vitest suites mirroring the source tree; shared helpers in `tests/helpers/`.

## Commands

- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — run the vitest suite once.
- `npm run lint` — oxlint.
- `npm run fmt` / `npm run fmt:check` — oxfmt (write / dry-run).
- `npm run preflight` — full gate (install, lint, fmt check, validate `server.json`, test, build, bundle). Run before a release.
- Git hooks: `lefthook` auto-installs on `npm install`. Pre-commit runs `oxfmt` (auto-fix on staged files) + `oxlint`. Pre-push runs `tsc --noEmit` + the test suite. Bypass with `--no-verify`.
- `npm run inspector` — watch-mode build + MCP Inspector UI for interactive debugging.

## Tool conventions

See [docs/tool-conventions.md](docs/tool-conventions.md) for tool design stance, description voice, parameter docs, annotation hints, sibling disambiguation, canonical MediaWiki terminology, and result-cap behavior. Consult before adding or modifying a tool.

## Documentation conventions

See [docs/documentation-conventions.md](docs/documentation-conventions.md) for the reader, register, and length rules for prose documentation. Consult before writing or editing `README.md`, `CHANGELOG.md`, or any page under `docs/`.

## Tool handlers

Each tool exports a typed descriptor (`name`, `description`, `inputSchema`, `annotations`, `handle`) from `src/tools/<name>.ts`. Tests import the descriptor and route through `dispatch( descriptor, ctx )` — see `tests/helpers/fakeContext.ts`.

## Adding or changing tools

A PR that adds, removes, or renames a tool — or that materially changes a tool's user-visible behaviour — must also update:

- **`README.md`** — the tool table near the top (name, one-line description, OAuth grant required).
- **`CHANGELOG.md`** — an entry under `## [Unreleased]` (Added / Changed / Removed / Breaking changes as appropriate, per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

Pure-internal refactors that don't change tool surface or behaviour don't need either.

## Adding an extension pack

A pack is a self-describing module exposing tools that share an extension gate. To add one:

1. Create `src/tools/extensions/<id>/<id>-<verb>.ts` for each tool, following the conventions in `docs/tool-conventions.md`.
2. Create `src/tools/extensions/<id>/index.ts` exporting the pack:
	```ts
	import type { ExtensionPack } from '../types.js';
	import { myTool } from './<id>-<verb>.js';

	// Convention: export name folds the id — `smwPack`, `bucketPack`, etc.
	export const myPack: ExtensionPack = {
		id: '<id>',
		extensionNames: ['CanonicalExtensionName' /*, aliases */],
		tools: [/* tool descriptors */],
	};
	```
3. Add the pack to the `extensionPacks` array in `src/tools/extensions/index.ts`.

Reconcile picks up the new pack automatically — no edits to `src/runtime/reconcile.ts`. README.md and CHANGELOG.md still need updating per the policy in "Adding or changing tools".

## Adding or changing environment variables

A PR that adds, removes, or renames an env var read by the server — or that changes its default or accepted values — must also update:

- **The right env-var table for the variable's tier.** Each variable lives in exactly one table: **`README.md`** for a core variable that applies to any setup; **`docs/deployment.md`** (the HTTP-transport or hosted-OAuth-proxy sub-table) for a variable that only matters when self-hosting the HTTP server or running the proxy; **`docs/configuration.md`** for a config-file substitution or upload-directory variable.
- **`server.json`** — the `environmentVariables` array in **both** the `mcpb` and `npm` package blocks, if the variable is one the install-time prompts should surface.
- **`CHANGELOG.md`** — an entry under `## [Unreleased]` if the change is user-visible.
- **`Dockerfile`** — only if the var needs a default baked into the docker image.

## Adding a client

A client that just pastes the standard block gets a row in the `Client | Configuration file | Root key` table under "Standard configuration" in the README, not a `###` section; confirm the configuration file path and root key against the client's own current documentation first, since a wrong path costs a user a debugging session.

A client earns its own `###` section when its configuration shape differs from the standard `mcpServers` object, as OpenCode's `mcp` key does, or when it needs install-flow prose a table row cannot carry: plugin install commands, a bundle download, install badges, or more than one configuration file location. Antigravity is an example of the latter: its configuration shape is the standard one, but it needs two file locations plus a note about importing an existing Gemini CLI setup.

Never add another copy of the launch configuration JSON: the standard configuration block exists once so that a change to the package name, flags, or environment variables needs only one edit.

See "Distribution" below for the channel map and the manifest contracts.

## Distribution

See [docs/distribution.md](docs/distribution.md) for the install channels, the Claude Code and Codex plugin layout, the manifest fields `scripts/sync-manifests.cjs` owns, and how to test an install before publishing. Consult before adding an install channel or editing a plugin manifest.

## Testing

Tool tests build a `ToolContext` via `fakeContext()` from `tests/helpers/fakeContext.ts` and dispatch through `dispatch( descriptor, ctx )`. Provide an `mwn` factory (typically `createMockMwn()` from `tests/helpers/mock-mwn.ts`) and override only the slices the test exercises. See [docs/testing.md](docs/testing.md) for the full pattern, MCP Inspector CLI examples, and the bot-password setup required to exercise authenticated tools against a local wiki.

## Releasing

See [docs/releasing.md](docs/releasing.md).
