# Changelog

All notable changes to this project are documented here.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- `update-file` tool for uploading a new revision of an existing file from local disk. (#304)
- `update-file-from-url` tool for uploading a new revision of an existing file from a URL. (#304)

### Changed

- `set-wiki` and `remove-wiki` are hidden from `tools/list` when fewer than two wikis are configured: `set-wiki` has nothing to switch to, and `remove-wiki` would orphan the server.

### Security

- HTTP transport refuses to start with static credentials in `config.json` unless `MCP_ALLOW_STATIC_FALLBACK=true` opts into a shared-identity deployment.

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

[Unreleased]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.7.0...HEAD
[0.7.0]: https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/compare/v0.6.5...v0.7.0
