# MediaWiki MCP Server
[![NPM Version](https://img.shields.io/npm/v/%40professional-wiki%2Fmediawiki-mcp-server?color=red)](https://www.npmjs.com/package/@professional-wiki/mediawiki-mcp-server) [![MIT licensed](https://img.shields.io/npm/l/%40professional-wiki%2Fmediawiki-mcp-server)](./LICENSE)

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Features

### Tools

Every tool that operates on a wiki accepts an optional `wiki` argument naming the wiki to act on (the wiki-management and OAuth tools do not) — pass a wiki key (e.g. `en.wikipedia.org`) or the full `mcp://wikis/{wikiKey}` URI. Omit it to use the configured default wiki (see [Configuration](#configuration)). Each tool response reports the wiki the call ran against.

#### Page reads

| Name | Description |
|---|---|
| `compare-pages` | Diff two versions of a wiki page by revision, title, or supplied wikitext. |
| `get-category-members` | List members of a category (up to 500 per call, paginated via `continueFrom`). |
| `get-file` | Fetch a file page. |
| `get-file-data` | Fetch a file's image bytes inline (base64) for visual analysis — for clients that can't reach the wiki host. Returns a scaled rendition (set `width`); non-renderable types (audio, video, binaries) error. For metadata or a download URL, use `get-file`. |
| `get-links-here` | List pages that reference a wiki page — pages that link to it, embed it as a template, or display it as a file (select via `type`), including pages that reach it through a redirect. Up to 500 per call, paginated via `continueFrom`. |
| `get-page` | Fetch a wiki page. |
| `get-page-history` | List recent revisions of a wiki page. |
| `get-pages` | Fetch multiple wiki pages in one call (up to 50). |
| `get-recent-changes` | List recent change events across the wiki, filterable by timestamp, namespace, user, tag, type, and hide flags (up to 50 per call, paginated via `continue`). |
| `get-revision` | Fetch a specific revision of a page. |
| `get-site-info` | Get a wiki's key settings: MediaWiki version, content language, title-case rules, namespaces, installed extensions, license, and (optionally) statistics. |
| `list-wikis` | List every configured wiki — its key, sitename, server, whether it is read-only or the default, whether it is reachable, which extension-gated tools work on it, and, for an OAuth-configured wiki, its authorization server. Disabled when fewer than two wikis are configured. |
| `parse-wikitext` | Render wikitext to HTML without saving. Returns parse warnings, wikilinks, templates, and external URLs. |
| `search-page` | Search wiki page titles and contents. |
| `search-page-by-prefix` | Search page titles by prefix. |
| `whoami` | Report the identity the current session is authenticated as on the targeted wiki — username, whether it is anonymous, and group memberships (optionally user rights). |

#### Page writes

| Name | Description | Permissions |
|---|---|---|
| `create-page` 🔐 | Create a new wiki page. | `Create, edit, and move pages` |
| `delete-page` 🔐 | Delete a wiki page. | `Delete pages, revisions, and log entries` |
| `move-page` 🔐 | Move (rename) a wiki page. | `Create, edit, and move pages` |
| `undelete-page` 🔐 | Undelete a wiki page. | `Delete pages, revisions, and log entries` |
| `update-file` 🔐 | Upload a new revision of an existing file from local disk. | `Upload, replace, and move files` |
| `update-file-from-url` 🔐 | Upload a new revision of an existing file from a URL. | `Upload, replace, and move files` |
| `update-page` 🔐 | Update an existing wiki page. | `Edit existing pages` |
| `upload-file` 🔐 | Upload a file to the wiki from local disk. | `Upload new files` |
| `upload-file-from-url` 🔐 | Upload a file to the wiki from a URL. | `Upload, replace, and move files` |

#### Wiki management

| Name | Description |
|---|---|
| `add-wiki` | Add a wiki as an MCP resource from its URL. Disabled when `allowWikiManagement` is `false`. |
| `remove-wiki` | Remove a wiki resource. Disabled when `allowWikiManagement` is `false` or fewer than two wikis are configured. |

#### OAuth

| Name | Description |
|---|---|
| `oauth-logout` | Remove stored OAuth tokens. Stdio only. |
| `oauth-status` | List stored OAuth tokens with scopes and expiry (no token values). Stdio only. |

#### Extension packs

Each pack's tools register only on wikis where its extension is installed.

**[NeoWiki](https://neowiki.ai/)**

| Name | Description |
|---|---|
| `neowiki-list-schemas` | List schemas (entity types) and their property counts. |
| `neowiki-get-schema` | Get one schema's property definitions, relations, and select options. |
| `neowiki-cypher-query` | Run a read-only Cypher query against the knowledge graph. |
| `neowiki-search-subjects` | Find subject IDs by label within a schema. |
| `neowiki-get-subject` | Fetch one subject's structured data by ID. |
| `neowiki-get-page-subjects` | List the subjects attached to a wiki page. |
| `neowiki-create-subject` | Create a subject (child or main) on a page. Requires the `edit` right. |
| `neowiki-update-subject` | Replace a subject's label and statements. Requires the `edit` right. |
| `neowiki-delete-subject` | Delete a subject by ID. Requires the `edit` right. |
| `neowiki-set-main-subject` | Set or clear a page's main subject. Requires the `edit` right. |
| `neowiki-validate-subject` | Dry-run validate a proposed subject and return violations. |

**[Semantic MediaWiki](https://www.mediawiki.org/wiki/Extension:Semantic_MediaWiki)**

| Name | Description |
|---|---|
| `smw-list-properties` | List Semantic MediaWiki properties with copy-paste templates for `smw-query`. |
| `smw-query` | Run a Semantic MediaWiki `#ask` query. |

**[Bucket](https://github.com/weirdgloop/mediawiki-extensions-Bucket)**

| Name | Description |
|---|---|
| `bucket-query` | Run a Bucket Lua query. |

**[Cargo](https://www.mediawiki.org/wiki/Extension:Cargo)**

| Name | Description |
|---|---|
| `cargo-list-tables` | List Cargo tables defined on the wiki. |
| `cargo-describe-table` | List a Cargo table's fields with their types and list-flags. |
| `cargo-query` | Run a Cargo SQL-style query. |

### Resources

**`mcp://wikis/{wikiKey}`** — per-wiki resource exposing `sitename`, `server` (the wiki's public address), `articlepath`, `scriptpath`, and a `private` flag.

- Credentials (`token`, `username`, `password`) are never exposed in resource content.
- After `add-wiki` or `remove-wiki`, the server sends `notifications/resources/list_changed` so clients refresh.

<details><summary>Example read result</summary>

```json
{
  "contents": [
    {
      "uri": "mcp://wikis/en.wikipedia.org",
      "mimeType": "application/json",
      "text": "{ \"sitename\":\"Wikipedia\",\"server\":\"https://en.wikipedia.org\",\"articlepath\":\"/wiki\",\"scriptpath\":\"/w\",\"private\":false }"
    }
  ]
}
```
</details>

### Environment variables
| Name | Description | Default |
|---|---|---|
| `CONFIG` | Path to your configuration file | `config.json` |
| `MCP_ALLOW_STATIC_FALLBACK` | Set to `true` to allow HTTP startup when `config.json` has static credentials. See [docs/deployment.md — security checklist](docs/deployment.md#security-checklist). | `unset` |
| `MCP_CONTENT_MAX_BYTES` | Byte cap for content bodies (wikitext, rendered HTML, diffs). Tune to the target LLM client's tool-response budget. | `50000` |
| `MCP_FILE_DATA_MAX_BYTES` | Hard cap on the base64-encoded size of a `get-file-data` response. A transport/safety backstop; tune the actual size per call with the tool's `width`. Over-cap calls error rather than truncate. | `1000000` |
| `MCP_UPLOAD_MAX_BYTES` | Memory cap on the server-side fetch used by `upload-file-from-url` / `update-file-from-url`. Files larger than this are handed to the wiki's own copy-upload instead of being buffered by the server. Guards this server's memory, not the wiki's `$wgMaxUploadSize`. | `104857600` |
| `MCP_LOG_LEVEL` | Minimum severity for logger output. One of `debug`, `info`, `notice`, `warning`, `error`, `critical`, `alert`, `emergency`, or `silent`. | `debug` |
| `MCP_OAUTH_ALLOWED_REDIRECTS` | Additional OAuth redirect URIs the hosted proxy accepts at client registration: comma-separated exact URIs (each must include a host) and `https://…/*` prefix patterns. Loopback, claude.ai, and verified first-party clients are always allowed. See [docs/deployment.md — allowing more clients](docs/deployment.md#allowing-more-clients). | `unset` |
| `MCP_OAUTH_CREDENTIALS_FILE` | Override the default credentials store path. Default: `~/.config/mediawiki-mcp/credentials.json` (Linux/macOS) or `%APPDATA%\mediawiki-mcp\credentials.json` (Windows). | `unset` |
| `MCP_OAUTH_NO_BROWSER` | Set to `1` to skip launching a browser during the OAuth flow; the auth URL is logged to stderr instead. Useful in headless environments. | `unset` |
| `MCP_PUBLIC_URL` | Override the request-derived public URL used in OAuth protected-resource discovery. Useful for reverse-proxy setups that rewrite the `Host` header. | `unset` |
| `MCP_MAX_REQUEST_BODY` | Maximum HTTP request body size (StreamableHTTP transport). Accepts size strings like `512kb` or `1mb`. Oversize requests get a JSON-RPC 413. | `1mb` |
| `MCP_METRICS` | Set to `true` to expose Prometheus metrics at `GET /metrics` on the HTTP transport. | `unset` |
| `MCP_SESSION_IDLE_TIMEOUT` | Seconds an HTTP session may sit idle before it is closed and removed (StreamableHTTP transport). Any request resets the timer. `0` disables expiry. | `1800` |
| `MCP_SHUTDOWN_GRACE_MS` | Maximum ms to wait for in-flight `/mcp` calls to drain on `SIGTERM` / `SIGINT`. See [docs/operations.md — Graceful shutdown](docs/operations.md#graceful-shutdown). | `10000` |
| `MCP_TRANSPORT` | Type of MCP server transport (`stdio` or `http`) | `stdio` |
| `MCP_TRUSTED_HOSTS` | Comma-separated hosts exempt from the **outbound** SSRF guard's public-IP check — for deliberately pointing the server at an internal destination such as a Docker-network alias (`mediawiki.svc`). Distinct from the inbound `MCP_ALLOWED_HOSTS`; see [Security](#security). | `unset` |
| `PORT` | Port used for StreamableHTTP transport | `3000` |

## Configuration

> [!NOTE]
> Config is only required when interacting with a private wiki or using authenticated tools.

Create a `config.json` file to configure wiki connections. Use the `config.example.json` as a starting point.

```json
{
  "defaultWiki": "en.wikipedia.org",
  "wikis": {
    "en.wikipedia.org": {
      "sitename": "Wikipedia",
      "server": "https://en.wikipedia.org",
      "articlepath": "/wiki",
      "scriptpath": "/w"
    }
  }
}
```

**Internal vs public address.** The `server` you configure is the address the MCP server uses to reach the wiki's API — it may be an internal hostname (e.g. `http://mediawiki` in Docker). URLs handed back to the AI (page links, the `server` field in `list-wikis` and `mcp://wikis` resources) are built from the wiki's own public address, so internal hostnames don't leak into links. If a wiki can't be reached, links fall back to the configured `server`.

For the full field reference, env-var substitution, secret sources, change tags, upload directories, and authentication options, see [docs/configuration.md](docs/configuration.md).

## Authentication

Tools marked 🔐 require authentication. Write tools (including extension-pack writes) are hidden from `tools/list` when the configured default wiki has `readOnly: true` — see [Deployment](#deployment).

- **Browser-based OAuth (recommended).** Sign in through a browser tab the first time a tool needs auth. Set `oauth2ClientId` and `oauth2CallbackPort` per wiki — see [docs/configuration.md — OAuth (browser-based)](docs/configuration.md#oauth-browser-based).
- **Per-request bearer token (HTTP).** Each request carries `Authorization: Bearer <token>`; the server forwards it to MediaWiki. See [docs/deployment.md — per-request bearer token](docs/deployment.md#per-request-bearer-token-http-transport).
- **Hosted OAuth proxy (HTTP).** The server fronts one MediaWiki consumer as an OAuth 2.1 Authorization Server, so an OAuth-aware client signs each user in — no manual tokens. Point it at `https://<wiki>/mcp`; anonymous read still works. See [docs/deployment.md — hosted OAuth sign-in](docs/deployment.md#hosted-oauth-sign-in).
- **Manual OAuth2 access token.** Paste a long-lived token into `config.json`. See [docs/configuration.md — manual OAuth2 access token](docs/configuration.md#manual-oauth2-access-token).
- **Bot password.** Fallback when Extension:OAuth isn't installed. See [docs/configuration.md — bot password](docs/configuration.md#bot-password).

The Cargo tools (`cargo-query`, `cargo-list-tables`, `cargo-describe-table`) call API actions gated by the `runcargoqueries` user right. Most wikis grant this to all users by default; wikis that restrict it require the **`Create, query and delete data through the Cargo extension`** grant on the bot password or OAuth consumer. The Cargo extension is also detected on wiki.gg-hosted wikis (Helldivers, Terraria, Ark, etc.), where it ships under the rebranded name `LIBRARIAN`.

## Installation

<details>
<summary><b>Install in Claude Desktop</b></summary>

Follow the [guide](https://modelcontextprotocol.io/quickstart/user), use following configuration:

```json
{
  "mcpServers": {
    "mediawiki-mcp-server": {
      "command": "npx",
      "args": [
        "@professional-wiki/mediawiki-mcp-server@latest"
      ],
      "env": {
        "CONFIG": "path/to/config.json"
      }
    }
  }
}
```
</details>

<details><summary><b>Install in VS Code</b></summary>

[![Install in VS Code](https://img.shields.io/badge/Add%20to-VS%20Code-blue?style=for-the-badge&labelColor=%230e1116&color=%234076b5)](https://insiders.vscode.dev/redirect?url=vscode%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522mediawiki-mcp-server%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522%2540professional-wiki%252Fmediawiki-mcp-server%2540latest%2522%255D%257D)
[![Install in VS Code Insiders](https://img.shields.io/badge/Add%20to-VS%20Code%20Insiders-blue?style=for-the-badge&labelColor=%230e1116&color=%234f967e)](https://insiders.vscode.dev/redirect?url=vscode-insiders%3Amcp%2Finstall%3F%257B%2522name%2522%253A%2522mediawiki-mcp-server%2522%252C%2522command%2522%253A%2522npx%2522%252C%2522args%2522%253A%255B%2522%2540professional-wiki%252Fmediawiki-mcp-server%2540latest%2522%255D%257D)

```bash
code --add-mcp '{"name":"mediawiki-mcp-server","command":"npx","args":["@professional-wiki/mediawiki-mcp-server@latest"]}'
```
</details>

<details>
<summary><b>Install in Cursor</b></summary>

[![Install in Cursor](https://cursor.com/deeplink/mcp-install-dark.svg)](https://cursor.com/install-mcp?name=mediawiki-mcp-server&config=eyJjb21tYW5kIjoibnB4IEBwcm9mZXNzaW9uYWwtd2lraS9tZWRpYXdpa2ktbWNwLXNlcnZlckBsYXRlc3QifQ%3D%3D)

Go to `Cursor Settings` -> `MCP` -> `Add new MCP Server`. Name to your liking, use `command` type with the command `npx @professional-wiki/mediawiki-mcp-server`. You can also verify config or add command like arguments via clicking `Edit`.

```json
{
  "mcpServers": {
    "mediawiki-mcp-server": {
      "command": "npx",
      "args": [
        "@professional-wiki/mediawiki-mcp-server@latest"
      ],
      "env": {
        "CONFIG": "path/to/config.json"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Install in Windsurf</b></summary>

Follow the [guide](https://docs.windsurf.com/windsurf/cascade/mcp), use following configuration:

```json
{
  "mcpServers": {
    "mediawiki-mcp-server": {
      "command": "npx",
      "args": [
        "@professional-wiki/mediawiki-mcp-server@latest"
      ],
      "env": {
        "CONFIG": "path/to/config.json"
      }
    }
  }
}
```
</details>

<details>
<summary><b>Install in Claude Code</b></summary>

Follow the [Claude Code MCP docs](https://docs.anthropic.com/en/docs/claude-code/mcp).

Run the below command, optionally with `-e` flags to specify environment variables.

    claude mcp add mediawiki-mcp-server npx @professional-wiki/mediawiki-mcp-server@latest

You should end up with something like the below in your `.claude.json` config:

```json
"mcpServers": {
  "mediawiki-mcp-server": {
    "type": "stdio",
    "command": "npx",
    "args": [
      "@professional-wiki/mediawiki-mcp-server@latest"
    ],
    "env": {
      "CONFIG": "path/to/config.json"
    }
  }
},
```
</details>

<details>
<summary><b>Install in Gemini CLI</b></summary>

Run:

```bash
gemini extensions install https://github.com/ProfessionalWiki/MediaWiki-MCP-Server
```

This installs the extension from the latest GitHub Release. To pin a specific version, append `--ref=<tag>` (for example `--ref=v0.6.5`).

See the [Gemini CLI extensions documentation](https://github.com/google-gemini/gemini-cli/tree/main/docs/extensions) for how to update, list, or uninstall extensions.
</details>

## Deployment

Running the server as a remote HTTP endpoint for other users has its own configuration requirements — see [docs/deployment.md](docs/deployment.md). A pre-built image is published at `ghcr.io/professionalwiki/mediawiki-mcp-server`. For day-2 operations (logs, `/health`/`/ready`, metrics, graceful shutdown), see [docs/operations.md](docs/operations.md).

## Security

Defaults are safe for single-user use. Before exposing the HTTP transport to others, lock down three things:

- **Trust the proxy, not the header.** The server forwards any `Authorization: Bearer` header straight to MediaWiki — authentication is the reverse proxy's job. Terminate TLS there, and don't expose the MCP port directly on an untrusted network. See [docs/deployment.md — security checklist](docs/deployment.md#security-checklist).
- **Pair `MCP_BIND` with `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS`.** The HTTP transport binds to `127.0.0.1` by default. When you open it up with `MCP_BIND=0.0.0.0`, set `MCP_ALLOWED_HOSTS` to the hostnames your proxy forwards and `MCP_ALLOWED_ORIGINS` to the browser origins allowed to call the server — these block DNS-rebinding and cross-origin attacks respectively.
- **Uploads are opt-in.** `upload-file` is disabled until you list allowed directories in `uploadDirs` or `MCP_UPLOAD_DIRS`. See [docs/configuration.md — upload directories](docs/configuration.md#upload-directories).
- **Internal destinations need `MCP_TRUSTED_HOSTS`.** Outbound fetches — the anonymous siteinfo probe, wiki discovery, `*-file-from-url` — are SSRF-guarded: a destination resolving to a private or loopback address is refused. To deliberately run against an internal host — e.g. a Docker-network alias like `mediawiki.svc` that bypasses your public proxy — list it in `MCP_TRUSTED_HOSTS` to exempt it from the public-IP check. The host is still resolved and pinned, and the guard stays on for every other destination. This is the **outbound** counterpart to the inbound `MCP_ALLOWED_HOSTS` (Host-header) check — the two are unrelated despite the similar names.

Report a vulnerability via GitHub's [security advisory form](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/security/advisories/new) — full policy in [SECURITY.md](SECURITY.md).

## Contributing

Contributions are welcome — pull requests and issues (bugs, feature requests, suggestions) both work.

- **Working on tool code?** Start from [AGENTS.md](AGENTS.md) for repo layout, commands, and testing patterns.
- **Adding or modifying a tool?** Read [docs/tool-conventions.md](docs/tool-conventions.md) — it covers description voice, parameter docs, annotation hints, and MediaWiki terminology conventions.
- **Running a release?** See [docs/releasing.md](docs/releasing.md).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
