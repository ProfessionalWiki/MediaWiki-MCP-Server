# MediaWiki MCP Server
[![NPM Version](https://img.shields.io/npm/v/%40professional-wiki%2Fmediawiki-mcp-server?color=red)](https://www.npmjs.com/package/@professional-wiki/mediawiki-mcp-server) [![smithery badge](https://smithery.ai/badge/@ProfessionalWiki/mediawiki-mcp-server)](https://smithery.ai/server/@ProfessionalWiki/mediawiki-mcp-server) [![MIT licensed](https://img.shields.io/npm/l/%40professional-wiki%2Fmediawiki-mcp-server)](./LICENSE)

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Features

### Tools

| Name | Description | Permissions |
|---|---|---|
| `add-wiki` | Add a wiki as an MCP resource from its URL. Disabled when `allowWikiManagement` is `false`. | - |
| `compare-pages` | Diff two versions of a wiki page by revision, title, or supplied wikitext. | - |
| `create-page` 🔐 | Create a new wiki page. | `Create, edit, and move pages` |
| `delete-page` 🔐 | Delete a wiki page. | `Delete pages, revisions, and log entries` |
| `get-category-members` | List members of a category (up to 500 per call, paginated via `continueFrom`). | - |
| `get-file` | Fetch a file page. | - |
| `get-page` | Fetch a wiki page. | - |
| `get-page-history` | List recent revisions of a wiki page. | - |
| `get-pages` | Fetch multiple wiki pages in one call (up to 50). | - |
| `get-recent-changes` | List recent change events across the wiki, filterable by timestamp, namespace, user, tag, type, and hide flags (up to 50 per call, paginated via `continue`). | - |
| `get-revision` | Fetch a specific revision of a page. | - |
| `parse-wikitext` | Render wikitext to HTML without saving. Returns parse warnings, wikilinks, templates, and external URLs. | - |
| `remove-wiki` | Remove a wiki resource. Disabled when `allowWikiManagement` is `false`. | - |
| `search-page` | Search wiki page titles and contents. | - |
| `search-page-by-prefix` | Search page titles by prefix. | - |
| `set-wiki` | Set the active wiki for the current session. | - |
| `undelete-page` 🔐 | Undelete a wiki page. | `Delete pages, revisions, and log entries` |
| `update-page` 🔐 | Update an existing wiki page. | `Edit existing pages` |
| `upload-file` 🔐 | Upload a file to the wiki from local disk. | `Upload new files` |
| `upload-file-from-url` 🔐 | Upload a file to the wiki from a URL. | `Upload, replace, and move files` |

### Resources

**`mcp://wikis/{wikiKey}`** — per-wiki resource exposing `sitename`, `server`, `articlepath`, `scriptpath`, and a `private` flag.

- Credentials (`token`, `username`, `password`) are never exposed in resource content.
- After `add-wiki` or `remove-wiki`, the server sends `notifications/resources/list_changed` so clients refresh.

<details><summary>Example list result</summary>

```json
{
  "resources": [
    {
      "uri": "mcp://wikis/en.wikipedia.org",
      "name": "wikis/en.wikipedia.org",
      "title": "Wikipedia",
      "description": "Wiki \"Wikipedia\" hosted at https://en.wikipedia.org"
    }
  ]
}
```
</details>

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
| `MCP_CONTENT_MAX_BYTES` | Byte cap for content bodies (wikitext, rendered HTML, diffs) returned by `get-page`, `get-pages`, `parse-wikitext`, and `compare-pages`. Oversized bodies are truncated with a trailing marker. Tune to the target LLM client's tool-response budget. | `50000` |
| `MCP_TRANSPORT` | Type of MCP server transport (`stdio` or `http`) | `stdio` |
| `PORT` | Port used for StreamableHTTP transport | `3000` |

## Configuration

> **Note:** Config is only required when interacting with a private wiki or using authenticated tools.

Create a `config.json` file to configure wiki connections. Use the `config.example.json` as a starting point.

### Basic structure

```json
{
  "allowWikiManagement": true,
  "defaultWiki": "en.wikipedia.org",
  "wikis": {
    "en.wikipedia.org": {
      "sitename": "Wikipedia",
      "server": "https://en.wikipedia.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "token": null,
      "username": null,
      "password": null,
      "private": false
    }
  }
}
```

### Configuration fields

| Field | Description |
|---|---|
| `allowWikiManagement` | Enables the `add-wiki` and `remove-wiki` tools. Set to `false` to freeze the list of configured wikis. Default: `true` |
| `defaultWiki` | The default wiki identifier to use (matches a key in `wikis`) |
| `wikis` | Object containing wiki configurations, keyed by domain/identifier |

### Wiki configuration fields

| Field | Required | Description |
|---|---|---|
| `sitename` | Yes | Display name for the wiki |
| `server` | Yes | Base URL of the wiki (e.g., `https://en.wikipedia.org`) |
| `articlepath` | Yes | Path pattern for articles (typically `/wiki`) |
| `scriptpath` | Yes | Path to MediaWiki scripts (typically `/w`) |
| `token` | No | OAuth2 access token for authenticated operations (preferred) |
| `username` | No | Bot username (fallback when OAuth2 is not available) |
| `password` | No | Bot password (fallback when OAuth2 is not available) |
| `private` | No | Whether the wiki requires authentication to read (default: `false`) |
| `readOnly` | No | When `true`, hides the six 🔐 write tools from `tools/list` while this wiki is active. Pairs with `allowWikiManagement: false` for a [hosted read-only endpoint](docs/deployment.md). Default: `false` |
| `tags` | No | Change tag(s) to apply to every write (string or array). The tag must exist and be active at `Special:Tags` — see [docs/configuration.md](docs/configuration.md#change-tags-tags) for details. |

> Environment variable substitution (`${VAR}`), secret sources that read from a password manager, and the plaintext-warning behavior are covered in [docs/configuration.md](docs/configuration.md).

## Authentication

Tools marked 🔐 require authentication. They are also hidden from `tools/list` when the active wiki has `readOnly: true` — see [Deployment](#deployment).

### OAuth2 (preferred)

1. Navigate to `Special:OAuthConsumerRegistration/propose/oauth2` on your wiki.
2. Select "This consumer is for use only by [YourUsername]".
3. Grant the permissions your tools need — see the Permissions column in the [Tools](#tools) table.
4. After approval, copy the **Access Token** into the `token` field for that wiki in `config.json`.

> OAuth2 requires the [OAuth extension](https://www.mediawiki.org/wiki/Special:MyLanguage/Extension:OAuth) on the wiki.

### Per-request bearer token (HTTP transport)

When using the HTTP transport, the server accepts a standard OAuth 2.1 `Authorization: Bearer <token>` header on each request (per the [MCP authorization spec](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization)). Any MCP client that supports HTTP transport authentication can be configured to send it, allowing each client to act as its own wiki user rather than sharing the `config.json` identity.

Example with Claude Code:

```bash
claude mcp add --transport http my-wiki https://wiki.example.org/mcp \
  --header "Authorization: Bearer <your-access-token>"
```

When no header is present, the server falls back to `config.json` credentials or anonymous access. See [docs/configuration.md](docs/configuration.md#per-request-bearer-token-http-transport) for details, precedence, trust-boundary guidance, and reverse-proxy requirements.

### Bot password (fallback)

If the OAuth extension isn't available, create a bot password at `Special:BotPasswords` and set `username` and `password` in `config.json` instead of `token`.

## Installation

<details><summary><b>Install via Smithery</b></summary>

To install MediaWiki MCP Server for Claude Desktop automatically via [Smithery](https://smithery.ai/server/@ProfessionalWiki/mediawiki-mcp-server):

```bash
npx -y @smithery/cli install @ProfessionalWiki/mediawiki-mcp-server --client claude
```
</details>

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

## Deployment

Running the server as a remote HTTP endpoint for other users has its own configuration requirements — see [docs/deployment.md](docs/deployment.md).

## Contributing

Contributions are welcome — pull requests and issues (bugs, feature requests, suggestions) both work.

- **Working on tool code?** Start from [AGENTS.md](AGENTS.md) for repo layout, commands, and testing patterns.
- **Adding or modifying a tool?** Read [docs/tool-conventions.md](docs/tool-conventions.md) — it covers description voice, parameter docs, annotation hints, and MediaWiki terminology conventions.
- **Running a release?** See [docs/releasing.md](docs/releasing.md).

## License

This project is licensed under the MIT License. See the [LICENSE](LICENSE) file for details.
