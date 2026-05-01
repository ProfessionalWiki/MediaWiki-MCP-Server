# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Fixed

- Bootstrap error path no longer leaks an unhandled-rejection warning when `main()` fails (e.g. config-loading errors). The fatal-error catch now exits with code 1 instead of re-throwing into a detached `.catch` chain.

## [0.9.0] - 2026-05-01

### Breaking changes

- Bumped `engines.node` to `>=22.12.0` (was `>=18`). Node 20 reached EOL in April 2026; Node 22 LTS is supported through April 2027. Downstream consumers pinned to Node 18 or 20 must upgrade.

### Added

- Browser-based OAuth 2.0 login. Set `oauth2ClientId` (and, for MediaWiki, `oauth2CallbackPort`) on a wiki entry to opt in. HTTP transport uses standard OAuth discovery (RFC 9728) plus `WWW-Authenticate` headers so OAuth-aware MCP clients can drive auth-code+PKCE flows. On stdio, the server opens a browser the first time a tool needs a token, stores the result in `~/.config/mediawiki-mcp/credentials.json`, and refreshes it before expiry. Static credentials in `config.json` continue to work for wikis that don't opt in.
  - Two new stdio-only tools: `oauth-status` (lists wikis with stored tokens, scopes, and expiry — never the values) and `oauth-logout` (removes stored tokens, one wiki or all).
  - Three new env vars: `MCP_OAUTH_CREDENTIALS_FILE` overrides the token-store path; `MCP_OAUTH_NO_BROWSER=1` skips the browser launch and logs the auth URL to stderr (useful in headless environments); `MCP_PUBLIC_URL` overrides the request-derived public URL for awkward proxy setups.
  - Two new per-wiki config fields: `oauth2ClientId` (public-client identifier from `Special:OAuthConsumerRegistration/propose/oauth2`) and `oauth2CallbackPort` (loopback port for the OAuth callback URL — required for MediaWiki's Extension:OAuth, which exact-matches the redirect URI).
- `MCP_LOG_LEVEL` env var (default `debug`) sets the minimum severity for logger output, filtering both stderr telemetry and the `sendLoggingMessage` broadcast. Accepts the eight RFC 5424 levels plus `silent`.
- `smw-query` and `smw-list-properties` tools for [Semantic MediaWiki](https://github.com/SemanticMediaWiki/SemanticMediaWiki) — runs `#ask` queries and discovers SMW properties with copy-paste templates. Auto-detected from `siteinfo`; only registered on wikis that have SMW installed.
- `bucket-query` tool for the [Bucket extension](https://github.com/weirdgloop/mediawiki-extensions-Bucket) — runs Lua-style queries and returns row-shaped results. Same gating.
- `cargo-query`, `cargo-list-tables`, and `cargo-describe-table` tools for the [Cargo extension](https://www.mediawiki.org/wiki/Extension:Cargo). Each calls one Cargo API action (`cargoquery` / `cargotables` / `cargofields`); same gating, and also recognised under the rebranded name `LIBRARIAN` used by wiki.gg-hosted wikis.
- Optional `GET /metrics` Prometheus endpoint on the HTTP transport, enabled with `MCP_METRICS=true`. Exposes tool-call counters, duration histograms, upstream status totals, active sessions, and readiness-probe failures.
- Graceful shutdown — `SIGTERM` and `SIGINT` drain in-flight `/mcp` calls and close active StreamableHTTP sessions before exit, emitting `event: "shutdown"` / `event: "shutdown_complete"` on stderr. Configurable via `MCP_SHUTDOWN_GRACE_MS` (default `10000`). Stdio transport closes its single transport on the same signals.
- `MCP_MAX_REQUEST_BODY` env var (default `1mb`) caps HTTP request body size, replacing body-parser's silent 100 kB default that was rejecting long-form wikitext edits. Oversize requests return a JSON-RPC 413; the resolved value appears in the startup banner.
- Published Docker image at `ghcr.io/professionalwiki/mediawiki-mcp-server`. Multi-arch (`linux/amd64`, `linux/arm64`); release builds carry SLSA provenance, SPDX SBOM, and a cosign keyless signature; edge builds (`master` tip) carry attestations only. Tag conventions and verification command in [`docs/deployment.md`](docs/deployment.md).

### Changed

- Reorganised user-facing docs: extracted `docs/operations.md` for day-2 concerns (logs, `/health`/`/ready`, metrics, graceful shutdown); moved per-request bearer and reverse-proxy documentation from `docs/configuration.md` into `docs/deployment.md`; slimmed the README's authentication section; consolidated manual-token and bot-password instructions in `docs/configuration.md`; converted blockquote callouts to GitHub admonitions.
- Hardened the Docker image. Build context is now an allow-list (`src/`, `package.json`, `package-lock.json`, `tsconfig.json`, `server.json`) rather than the entire repo. Image labels follow OCI image-spec: dropped the deprecated `maintainer` and hand-maintained `image.version`; added `image.title`, `image.url`, `image.source`, `image.licenses`, and a per-build `image.revision` populated from a `GIT_SHA` build arg. Both build stages now install dependencies with `npm ci --ignore-scripts` so third-party postinstall scripts can't run during the SLSA-attested build. The `node:lts-alpine` base is pinned by digest, with Dependabot tracking digest updates so base-image patches reach published builds via auditable git history.
- Switched the dev toolchain to compiled tooling for substantially faster iteration: `tsgo` (Go-based TypeScript 7 native compiler) drives build/watch/type-check; oxlint and oxfmt (Rust-based) replace ESLint and Prettier. The new lint pipeline also runs type-aware checks, catching unawaited Promises, unbound methods used as callbacks, and accidental stringification of non-plain objects. Published packages are unaffected.

### Fixed

- The dispatcher OAuth gate no longer fires for `add-wiki`, `set-wiki`, `remove-wiki`, `oauth-status`, or `oauth-logout`. These tools operate on server-local state (the wiki registry, the OAuth token store) and don't need a token for the active wiki. Without this fix, a wiki whose OAuth had gone stale would render those five tools unreachable — leaving no way to switch away from it or clear its tokens.
- Read-only wikis now hide the `update-file` and `update-file-from-url` tools. They were previously left enabled because the read-only gate's tool list was missing the two `update-file*` entries.
- Markdown payload formatter no longer renders class instances and other non-plain objects as the bare `[object Object]`.

## [0.8.0] - 2026-04-28

### Added

- `update-file` tool for uploading a new revision of an existing file from local disk. (#304)
- `update-file-from-url` tool for uploading a new revision of an existing file from a URL. (#304)
- Structured per-tool-call logs on stderr (`event: "tool_call"`) capturing tool, wiki, target, outcome, duration, caller hash, session, upstream status, and truncation. Stderr-only — never forwarded to MCP clients. (#313)
- `GET /ready` readiness probe that calls the default wiki's `siteinfo` (3s timeout, 5s cache). Returns 200 `ready` or 503 `not_ready`. (#313)
- Structured startup banner (`event: "startup"`) on server boot capturing version, transport, auth shape, configured wikis, and HTTP allowlists. Tokens, usernames, and passwords are never included. (#313)

### Changed

- `set-wiki` and `remove-wiki` are hidden from `tools/list` when fewer than two wikis are configured: `set-wiki` has nothing to switch to, and `remove-wiki` would orphan the server. (#312)
- Logger output is now one JSON object per stderr line, replacing the previous `<level>: <message> {<json>}` text shape. Operators with stderr parsers must update them or pipe through `jq -R 'fromjson? // empty'` (or `humanlog`) for live reading. (#313)

### Fixed

- Docker image now includes `server.json`, so containers start instead of crashing with `Cannot find module '../server.json'`. (#322)

### Security

- HTTP transport refuses to start with static credentials in `config.json` unless `MCP_ALLOW_STATIC_FALLBACK=true` opts into a shared-identity deployment. (#311)

## [0.7.0] - 2026-04-25

### Breaking changes

- HTTP transport now binds to `127.0.0.1` by default and validates the `Host` header. Deployments that exposed the server externally must explicitly set the bind address and trusted hosts. (#291)
- Streamable HTTP transport now validates the `Origin` header on incoming requests. Browser clients without an allowed origin will be rejected.
- All tool output has been reshaped to plain prose with unified field names. Clients that parsed the previous structured output need to be updated. (#293)
- Tool error shapes have been standardised. Clients that pattern-matched the previous error strings need to be updated. (#287)
- Smithery integration has been removed. Use the documented stdio, MCPB, or HTTP transports instead.

### Added

- `compare-pages` tool for server-side wikitext diffs.
- `parse-wikitext` tool for previewing rendered output, including categories, links, templates, and display title.
- `get-pages` tool for batched page fetches.
- `get-recent-changes` tool. (#289)
- Section editing and append/prepend modes on `update-page`. (#284)
- Per-request OAuth2 bearer token passthrough for HTTP transport, allowing each client to act as its own wiki user. (#282)
- Per-wiki `readOnly` configuration and a hosted deployment recipe. (#274)
- `allowWikiManagement` config option to disable `add-wiki` and `remove-wiki`. (#270)
- Configurable change tag for MCP-originated edits. (#271)
- `exec` credential source and fail-fast environment variable resolution for config secrets. (#269)
- MCP logging capability with a structured logger.
- `MCP_CONTENT_MAX_BYTES` environment variable for tuning the byte cap on read-tool output.
- Environment variable substitution in config files.
- Gemini CLI extension manifest. (#290)
- Server title, description, and instructions surfaced over MCP.

### Changed

- All tools migrated from the MediaWiki REST API to the `mwn` Action API. (#235)
- Tool descriptions rewritten under a new style guide.
- `latestId` is now optional on `update-page`.
- Content model is auto-detected by MediaWiki on page creation.
- Truncation is now signalled by `search-page`, `search-page-by-prefix`, `get-page-history`, and `get-category-members` when results are capped.
- `get-category-members` caps at 500 results with opaque cursor pagination, applied after filtering.
- `search-page` forwards the `limit` parameter only when explicitly set.
- `@modelcontextprotocol/sdk` floor bumped to `^1.29.0`.
- Documentation reorganised by audience. (#280)

### Security

- HTTP transport binds to `127.0.0.1` by default with `Host`-header validation. (#291)
- Streamable HTTP transport validates the `Origin` header on incoming requests.
- HTTP sessions are bound to the bearer token used to initialise them. (#292)
- `add-wiki` blocks SSRF by validating discovery URLs.
- `upload-file` is gated behind a configurable upload-directory allowlist. (#288)
- `SECURITY.md` added with the disclosure policy.
- Transitive dependencies bumped to patched versions.

### Removed

- Smithery integration.

[Unreleased]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.6.5...v0.7.0
