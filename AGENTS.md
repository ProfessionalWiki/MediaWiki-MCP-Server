# AGENTS.md

Project context for AI coding agents working on this repo. For human users, start from [README.md](README.md).

## Repo layout

- `src/tools/` — one file per MCP tool (`handleXxxTool` handler + schema + registration).
- `src/common/` — `mwn` wrapper, `wikiService`, config loading and substitution.
- `src/resources/` — MCP resources exposing `mcp://wikis/{wikiKey}`.
- `src/server.ts`, `src/stdio.ts`, `src/streamableHttp.ts`, `src/index.ts` — entry points and transports.
- `tests/` — vitest suites; shared helpers in `tests/helpers/`.

## Commands

- `npm run build` — compile TypeScript to `dist/`.
- `npm test` — run the vitest suite once.
- `npm run lint` — ESLint.
- `npm run preflight` — full gate (install, lint, validate `server.json`, test, build, bundle). Run before a release.
- `npm run inspector` — watch-mode build + MCP Inspector UI for interactive debugging.

## Tool conventions

See [docs/tool-conventions.md](docs/tool-conventions.md) for tool design stance, description voice, parameter docs, annotation hints, sibling disambiguation, canonical MediaWiki terminology, and result-cap behavior. Consult before adding or modifying a tool.

## Tool handlers

`handleXxxTool` functions must be exported from `src/tools/<name>.ts` so unit tests can import them.

## Testing

Unit tests mock `getMwn` and `wikiService` **before** importing the handler under test. Use `createMockMwn()` from `tests/helpers/mock-mwn.ts`. See [docs/testing.md](docs/testing.md) for the full pattern, MCP Inspector CLI examples, and the bot-password setup required to exercise authenticated tools against a local wiki.

## Releasing

See [docs/releasing.md](docs/releasing.md).
