# AGENTS.md

Project context for AI coding agents working on this repo. For human users, start from [README.md](README.md).

## Repo layout

- `src/tools/` — one file per MCP tool (descriptor + handler + registration).
- `src/runtime/` — context, dispatcher, register, reconcile, logger, constants.
- `src/wikis/` — wiki registry, selection, mwn provider, discovery, error sanitiser.
- `src/transport/` — stdio and streamable HTTP entry points, SSRF/upload guards, request context, low-level HTTP helpers.
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
- Git hooks: `lefthook` auto-installs on `npm install`. Pre-commit runs `oxfmt` (auto-fix on staged files) + `oxlint`. Pre-push runs `tsgo --noEmit` + the test suite. Bypass with `--no-verify`.
- `npm run inspector` — watch-mode build + MCP Inspector UI for interactive debugging.

## Tool conventions

See [docs/tool-conventions.md](docs/tool-conventions.md) for tool design stance, description voice, parameter docs, annotation hints, sibling disambiguation, canonical MediaWiki terminology, and result-cap behavior. Consult before adding or modifying a tool.

## Tool handlers

Each tool exports a typed descriptor (`name`, `description`, `inputSchema`, `annotations`, `handle`) from `src/tools/<name>.ts`. Tests import the descriptor and route through `dispatch( descriptor, ctx )` — see `tests/helpers/fakeContext.ts`.

## Adding or changing tools

A PR that adds, removes, or renames a tool — or that materially changes a tool's user-visible behaviour — must also update:

- **`README.md`** — the tool table near the top (name, one-line description, OAuth grant required).
- **`CHANGELOG.md`** — an entry under `## [Unreleased]` (Added / Changed / Removed / Breaking changes as appropriate, per [Keep a Changelog](https://keepachangelog.com/en/1.1.0/)).

Pure-internal refactors that don't change tool surface or behaviour don't need either.

## Adding or changing environment variables

A PR that adds, removes, or renames an env var read by the server — or that changes its default or accepted values — must also update:

- **`README.md`** — the environment-variable table.
- **`server.json`** — the `environmentVariables` array in **both** the `mcpb` and `npm` package blocks.
- **`CHANGELOG.md`** — an entry under `## [Unreleased]` if the change is user-visible.
- **`Dockerfile`** — only if the var needs a default baked into the docker image.

## Testing

Tool tests build a `ToolContext` via `fakeContext()` from `tests/helpers/fakeContext.ts` and dispatch through `dispatch( descriptor, ctx )`. Provide an `mwn` factory (typically `createMockMwn()` from `tests/helpers/mock-mwn.ts`) and override only the slices the test exercises. See [docs/testing.md](docs/testing.md) for the full pattern, MCP Inspector CLI examples, and the bot-password setup required to exercise authenticated tools against a local wiki.

## Releasing

See [docs/releasing.md](docs/releasing.md).
