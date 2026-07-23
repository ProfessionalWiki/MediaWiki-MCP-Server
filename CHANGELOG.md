# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Breaking changes

- Hosted OAuth proxy: the upstream OAuth consumer must now be **confidential**. Set `oauth2ClientSecret` (or the `MCP_OAUTH2_CLIENT_SECRET` environment variable) for the default wiki; the proxy refuses to start without it. A confidential consumer is what lets the proxy refresh the upstream token, so users stay signed in past the wiki's OAuth2 access-token lifetime (one hour by default). A deployment using a public or PKCE consumer must register a confidential one and supply its secret.

### Added

- Edit attribution can now be turned off per wiki. Set `"attributeEdits": false` in a wiki's `config.json` entry to drop the `(via <tool> on MediaWiki MCP Server)` suffix from page and file edit summaries. It stays on by default.
- Claude Code and Codex can now install the server as a plugin. Add the repository as a plugin marketplace once, then install from it, instead of writing configuration by hand. See the README install section.
- Hosted OAuth proxy: verified first-party MCP clients now work out of the box. Their OAuth callbacks are trusted by default, with no `MCP_OAUTH_ALLOWED_REDIRECTS` configuration.
- Hosted OAuth proxy: the `MCP_OAUTH_ALLOWED_REDIRECTS` environment variable lets a deployment admit further MCP clients beyond the trusted defaults. List exact redirect URIs, or use an `https://…/*` prefix pattern. Loopback, claude.ai, and the verified first-party clients always remain allowed.
- Hosted OAuth proxy: support for Client ID Metadata Documents (CIMD). A CIMD-capable client connects using a stable, vendor-hosted identity, so there is no per-client redirect entry to curate. The proxy trusts the verified first-party document hosts by default; add more with `MCP_OAUTH_CIMD_ALLOWED_HOSTS`.
- Hosted OAuth proxy: the consent page now shows where the user will be sent after approving, either the client's callback host or "an application on this device" for a local client.
- Hosted OAuth proxy: IPv6 loopback (`http://[::1]:…`) redirect URIs are now accepted at client registration, per RFC 8252.
- Metrics: the `/metrics` endpoint now reports the hosted OAuth proxy store's size and flush cost, so operators can watch the store grow, see how long each persistence write takes, and alert when one fails. The new series are the `mcp_proxy_store_upstream_tokens` and `mcp_proxy_store_clients` gauges, an `mcp_proxy_store_flush_duration_seconds` histogram, and an `mcp_proxy_store_flush_failures_total` counter.

### Changed

- The documented install configurations and one-click install badges now pass `-y` to npx, matching the bundled plugin manifests. This avoids an install-confirmation step for anyone whose npm is configured to require one.
- Hosted OAuth proxy: sign-in state now survives server restarts and deploys. Registered clients and upstream tokens are persisted to a local, encrypted file, so users are no longer signed out on every upgrade. In Docker, mount a volume at the store path (`/app/data`); see the deployment guide.

### Removed

- The Gemini CLI extension has been retired, because Gemini CLI stopped serving consumer Google AI tiers in June 2026. Use Antigravity instead, which offers to import an existing Gemini CLI configuration. If your licence keeps Gemini CLI (for example a Code Assist Standard or Enterprise licence), add the standard configuration to its `~/.gemini/settings.json`.

### Fixed

- Clients no longer show a spurious `Expected ',' or ']' after array element in JSON` warning next to otherwise successful requests.
- The HTTP server now logs a clear message and exits cleanly when it cannot bind its port, for example because the port is already in use or permission is denied, instead of terminating with an uncaught exception and a raw stack trace.
- Hosted OAuth proxy: a client that identifies by a vendor-hosted URL (Client ID Metadata Document) is now rejected if any redirect URI in its document is not an `https`, loopback-`http`, or custom-scheme (for example `vscode://`) URL. A cleartext `http` redirect to a non-loopback host would let a network attacker on that path intercept the authorization code.
- Hosted OAuth proxy: clients that use a loopback callback on a variable port, including those that register a portless `http://127.0.0.1/` URI, now complete the flow instead of failing with "redirect_uri not registered", per RFC 8252.
- Hosted OAuth proxy: an upstream token refresh the wiki rejects with `invalid_client` (client authentication failed) is now reported as an authentication failure, so the client prompts for sign-in again instead of looping on a retryable "temporarily unavailable".
- Hosted OAuth proxy: a momentary wiki outage while refreshing a near-expiry token on an active connection no longer forces the client to sign in again. The request continues with the still-valid token, or gets a retryable response, instead of a sign-in challenge triggered by a transient failure. Concurrent requests that both trigger a refresh now share one upstream refresh rather than racing.

## [0.13.1] - 2026-07-09

### Fixed

- Trying to create, edit, or move a page in a protected namespace without the required right is now reported as a permission error rather than a generic upstream failure.
- An expired or invalid OAuth access token is now reported as an authentication error rather than a generic upstream failure, so an OAuth-aware client can tell the token needs to be refreshed.

## [0.13.0] - 2026-06-17

### Added

- **Hosted OAuth proxy (HTTP transport).** Opt-in mode in which the server signs each user into MediaWiki as themselves, so an OAuth-aware client pointed at `https://<wiki>/mcp` needs no manual tokens. Anonymous read still works; writes require sign-in. Enable it by running the HTTP transport with `MCP_PUBLIC_URL` and `MCP_OAUTH_JWT_SIGNING_KEY` set and an `oauth2ClientId` on the default wiki. See [docs/deployment.md — hosted OAuth sign-in](docs/deployment.md#hosted-oauth-sign-in).
- New per-wiki `publicServer` field: the browser-facing base URL, used when it differs from the internal `server` (e.g. a Docker-network alias). Defaults to `server`.
- New hosted-proxy environment variables: `MCP_PUBLIC_URL` (the server's public URL), `MCP_OAUTH_JWT_SIGNING_KEY` (≥32 characters), `MCP_OAUTH2_CLIENT_ID` (the default wiki's OAuth2 client id — overrides `config.json`, so a deployment can supply the value its wiki generates at registration time), `MCP_OAUTH_TOKEN_TTL` (default `55m`), and `MCP_OAUTH_CONSENT_TTL` (default `30d`). Durations accept forms like `55m`/`1h`/`30d` or bare seconds.
- **`private` wikis require sign-in over HTTP.** A wiki configured `private: true` (its MediaWiki disallows anonymous reads) now challenges every anonymous HTTP request — including the initial connection — with a `401`, so an OAuth-capable client prompts for login at connect instead of failing later. Public wikis are unchanged: anonymous reads still work, and only writes prompt for sign-in.

### Changed

- The OAuth sign-in and consent pages now have a styled layout instead of bare HTML, and a failed or cancelled authorization shows a readable page rather than a raw error.

### Fixed

- Extension-pack write tools (NeoWiki's `create-subject`, `update-subject`, `delete-subject`, and `set-main-subject`) are now hidden from `tools/list` and rejected by the per-call guard when the active wiki is configured `readOnly`, the same as core write tools. Previously the read-only gate covered only the core writes, so a read-only endpoint still advertised and dispatched extension-pack writes; an actual write was then stopped only by the wiki's own permissions. Write tools are identified by their `readOnlyHint: false` annotation, so future packs are covered automatically. (#411)

## [0.12.0] - 2026-06-11

### Added

- `MCP_TRUSTED_HOSTS` environment variable: a comma-separated allowlist of hosts exempt from the outbound SSRF guard's public-IP check, letting you deliberately point the server at an internal destination — such as a Docker-network alias like `mediawiki.svc` behind a reverse proxy. Without it, the anonymous siteinfo probe to a private address is refused, so extension-gated tools (Cargo, Semantic MediaWiki, Bucket, NeoWiki) never register and `get-site-info` reports no extensions. A bare host matches any port and `host:port` matches only that port; matching is exact, and a listed host is still DNS-resolved and pinned. Separate from the inbound `MCP_ALLOWED_HOSTS` Host-header allowlist. (#410)

## [0.11.0] - 2026-06-10

### Added

- NeoWiki integration: tools to explore a NeoWiki knowledge graph — list schemas, inspect a schema's properties, search subjects by name, fetch a subject or a page's subjects, and run read-only Cypher queries. Available on wikis with the NeoWiki extension installed.
- NeoWiki write tools: create a subject on a page (as a child or the main subject), replace a subject's label and statements, delete a subject, set or clear a page's main subject, and dry-run validate a proposed subject before writing. The four write tools require the `edit` right on the target wiki; validation is read-only. Available on wikis with the NeoWiki extension installed.
- `get-file-data` tool: returns a wiki file's image inline (base64) so clients that can't reach the wiki host can still send the image to the model for visual analysis. Returns a scaled rendition sized by `width`. Images and files MediaWiki can rasterize (SVG, PDF, DjVu) come back as an image; non-renderable types (audio, video, binaries) error and point to `get-file`.
- `MCP_FILE_DATA_MAX_BYTES` environment variable: a hard ceiling on the encoded size of a `get-file-data` response (default 1 MB).
- `whoami` tool: reports which account the current session is acting as on a wiki — the username, whether the session is anonymous, and the user groups it belongs to (optionally the full rights list). Use it to confirm who edits will be attributed to before writing, for example when creating a page under your own user namespace.
- `MCP_UPLOAD_MAX_BYTES` environment variable: caps the size the server buffers when fetching a URL for `upload-file-from-url` / `update-file-from-url` (default 100 MB). Larger files are handed to the wiki's own copy-upload.
- `update-page` and `create-page` accept a `bot` parameter that marks the edit as a bot edit. The flag takes effect only when the authenticated account has the `bot` right (bot group, or the high-volume grant on a bot password or OAuth consumer); the response reports whether the flag applied via `botMarked`.

### Changed

- List responses (`get-recent-changes`, `get-page-history`, `get-links-here`, `get-category-members`, `get-pages`) now omit default and empty fields to reduce response size: boolean flags appear only when `true`, empty comments and tag lists are dropped, recent changes report the size delta without the raw old/new lengths, a category member's `type` is omitted for ordinary pages, and `get-pages` omits `requestedTitle` when it matches the resolved title. Absent flags mean `false`.
- The `list-wikis` tool is now hidden when only a single wiki is configured, where it has nothing to list and every call already defaults to that wiki. It appears once a second wiki is configured or added.
- The timeout for an `exec`-backed credential command was raised from 10 to 30 seconds, giving an interactive unlock (such as a 1Password prompt) time to be approved. If the command still times out, the error now explains that approving the prompt and retrying re-runs it.
- `exec`-backed credential commands now run one at a time instead of concurrently. Resolving secrets for several wikis at once (for example when listing wikis) previously launched every command together, so an interactive unlock such as a 1Password prompt appeared once per wiki; now the first command's unlock is reused by the rest, so a single prompt covers them all.
- `list-wikis` no longer logs into or unlocks credentials for each configured wiki. It now reads each wiki's public site data anonymously, so listing wikis never triggers a credential prompt or a login — authentication happens only when you act on a wiki.
- `upload-file-from-url` and `update-file-from-url` now work on wikis without upload-by-URL enabled. The server fetches the file and uploads it directly, only asking the wiki to fetch the URL when the server cannot reach it (for example a private, server-unreachable address). Previously these tools failed unless the wiki had copy-uploads enabled and the account held the `upload_by_url` right.

## [0.10.0] - 2026-05-30

### Security

- Updated dependencies to resolve known advisories, including a high-severity issue in the HTTP client used for outbound wiki requests.

### Breaking changes

- Removed the `set-wiki` tool. Pass the `wiki` argument on each tool call instead.
- `remove-wiki` now refuses to remove the configured default wiki (it previously refused to remove the wiki that was currently selected).

### Added

- `get-site-info` tool: returns a wiki's MediaWiki version, content language, title case-sensitivity, maximum page size, namespace map, installed extensions, and content license; optionally page/article/user/edit statistics.
- `move-page` tool that renames a wiki page (and, by default, its talk page), optionally moving subpages and suppressing the redirect left at the old title.
- `get-links-here` tool that lists the pages referencing a target page — pages that link to it, embed it as a template, or display it as a file — including pages that reach it through a redirect.
- `list-wikis` tool reporting every configured wiki — its key, sitename, server, whether it is read-only or the default, whether it is reachable, which extension-gated tools work on it, and, for an OAuth-configured wiki, its authorization server.
- Optional `wiki` argument on every tool that operates on a wiki (all except the wiki-management and OAuth tools), naming the wiki that call acts on. Accepts a wiki key (e.g. `en.wikipedia.org`) or the full `mcp://wikis/{wikiKey}` URI.
- Tool responses now report the wiki the call ran against.
- `MCP_SESSION_IDLE_TIMEOUT` env var (default `1800` seconds) closes HTTP sessions that have been idle for the configured window. Any request resets the timer; setting it to `0` disables expiry.

### Changed

- URLs returned by the server — page links, and the `server` reported by `list-wikis` and the `mcp://wikis` resource — now use the wiki's own public address rather than the address configured for API access. This corrects links when the wiki is reached over an internal or Docker hostname. Links fall back to the configured address when the wiki is unreachable.
- Tool calls target a wiki named per call, defaulting to the configured default wiki, instead of a server-side selection that had to be set first.
- Extension-gated tools (`cargo-*`, `smw-*`, `bucket-query`) and the write tools are now offered whenever *any* configured wiki supports them, instead of only when the default wiki does. A call targeting a wiki that lacks the capability returns a clear error.
- Wiki credentials backed by an `exec` command are now fetched the first time that wiki is used, instead of when the server starts. A slow or failing credential command no longer delays startup or prevents the server from starting — the error now appears only when that wiki is used.
- The HTTP transport's OAuth discovery now covers every configured wiki: the `/.well-known/oauth-protected-resource` document advertises every OAuth wiki's authorization server, and a tokenless client is challenged only when no configured wiki is usable without a token — a deployment that mixes OAuth and non-OAuth wikis still serves tokenless clients.
- An HTTP client may now send a different `Authorization: Bearer` token per request, so one session can work with wikis on different authorization servers. A call targeting an OAuth wiki with no usable token returns a clear authentication error.

## [0.9.1] - 2026-05-13

### Changed

- Documented the `/mcp` endpoint path explicitly in `docs/deployment.md`.

### Fixed

- Startup failures (e.g. config-loading errors) now exit with code 1 instead of leaking a Node unhandled-rejection warning on stderr.
- Bot-password sessions are now renewed automatically when the MediaWiki session expires (default `$wgObjectCacheSessionExpiry` = 1 hour). Previously, write tools (e.g. `update-page`, `create-page`) failed with `permissiondenied` after the expiry and only a server restart recovered.

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

[Unreleased]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.13.1...HEAD
[0.13.1]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.13.0...v0.13.1
[0.13.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.12.0...v0.13.0
[0.12.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.11.0...v0.12.0
[0.11.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.10.0...v0.11.0
[0.10.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.9.1...v0.10.0
[0.9.1]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.9.0...v0.9.1
[0.9.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.8.0...v0.9.0
[0.8.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.7.0...v0.8.0
[0.7.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.6.5...v0.7.0
