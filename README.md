# MediaWiki MCP Server
[![NPM Version](https://img.shields.io/npm/v/%40professional-wiki%2Fmediawiki-mcp-server?color=red)](https://www.npmjs.com/package/@professional-wiki/mediawiki-mcp-server) [![smithery badge](https://smithery.ai/badge/@ProfessionalWiki/mediawiki-mcp-server)](https://smithery.ai/server/@ProfessionalWiki/mediawiki-mcp-server) [![GPL 2.0 licensed](https://img.shields.io/npm/l/%40professional-wiki%2Fmediawiki-mcp-server)](./LICENSE)

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Feature

### Tools

| Name | Description | Permissions |
|---|---|---|
| `create-page` 🔐 | Create a new wiki page. | `Create, edit, and move pages` |
| `delete-page` 🔐 | Delete a wiki page. | `Delete pages, revisions, and log entries` |
| `get-file` | Returns the standard file object for a file page. | - |
| `get-page` | Returns the standard page object for a wiki page. | - |
| `get-page-history` | Returns information about the latest revisions to a wiki page. | - |
| `get-revision` | Returns the standard revision object for a page. | - |
| `search-page` | Search wiki page titles and contents for the provided search terms. | - |
| `set-wiki` | Set the wiki to use for the current session. | - |
| `undelete-page` 🔐 | Undelete a wiki page. | `Delete pages, revisions, and log entries` |
| `update-page` 🔐 | Update an existing wiki page. | `Edit existing pages` |
| `upload-file` 🔐 | Uploads a file to the wiki from the local disk. | `Upload new files` |
| `upload-file-from-url` 🔐 | Uploads a file to the wiki from a web URL. | `Upload, replace, and move files` |

### Environment variables
| Name | Description | Default |
|---|---|---|
| `CONFIG` | Path to your configuration file | `config.json` |
| `MCP_TRANSPORT` | Type of MCP server transport (`stdio` or `http`) | `stdio` |
| `PORT` | Port used for StreamableHTTP transport | `3000` |

## Configuration

> **Note:** Config is only required when interacting with a private wiki or using authenticated tools.

Create a `config.json` file to configure wiki connections. Use the `config.example.json` as a starting point.

### Basic structure

```json
{
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

### Authentication setup

For tools marked with 🔐, authentication is required.

**Preferred method: OAuth2 Token**

1. Navigate to `Special:OAuthConsumerRegistration/propose/oauth2` on your wiki
2. Select "This consumer is for use only by [YourUsername]"
3. Grant the necessary permissions
4. After approval, you'll receive:
   - Client ID
   - Client Secret
   - Access Token
5. Add the `token` to your wiki configuration in `config.json`

> **Note:** OAuth2 requires the [OAuth extension](https://www.mediawiki.org/wiki/Special:MyLanguage/Extension:OAuth) to be installed on the wiki.

**Fallback method: Username & Password**

If OAuth2 is not available on your wiki, you can use bot credentials (from `Special:BotPasswords` ) instead of the OAuth2 token.

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

## Development

> 🐋 **Develop with Docker:** Replace the `npm run` part of the command with `make` (e.g. `make dev`).

### [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

To start the development server and the MCP Inspector:
```sh
npm run dev
```

The command will build and start the MCP Proxy server locally at `6277` and the MCP Inspector client UI at `http://localhost:6274`.

### Test with MCP clients

To enable your MCP client to use this MediaWiki MCP Server for local development: 

1. [Install](#installation) the MCP server on your MCP client.
2. Change the `command` and `args` values as shown in the [`mcp.json`](mcp.json) file (or [`mcp.docker.json`](mcp.docker.json) if you prefer to run the MCP server in Docker).
3. Run the watch command so that the source will be compiled whenever there is a change:

	```sh
	npm run watch
	```

### Release process

To release a new version:

<details>
<summary><b>1. Use npm version to create a release</b></summary>

```sh
# For patch release (0.1.1 → 0.1.2)
npm version patch

# For minor release (0.1.1 → 0.2.0)
npm version minor

# For major release (0.1.1 → 1.0.0)
npm version major

# Or specify exact version
npm version 0.2.0
```

This command automatically:
- Updates `package.json` and `package-lock.json`
- Syncs the version in `server.json` (via the version script)
- Creates a git commit
- Creates a git tag (e.g., `v0.2.0`)
</details>

<details>
<summary><b>2. Push to GitHub</b></summary>

```sh
git push origin master --follow-tags
```
</details>

<details>
<summary><b>3. Create a GitHub Release</b></summary>

1. Go to the [Releases page](https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/releases)
2. Click "Create a new release"
3. Select the tag you just pushed (e.g., `v0.2.0`)
4. Add a title and release notes
5. Click "Publish release"

The GitHub Actions workflow will automatically:
- Build and publish to [NPM](https://www.npmjs.com/package/@professional-wiki/mediawiki-mcp-server) 
- Publish to the [MCP Registry](https://registry.modelcontextprotocol.io/v0/servers?search=io.github.professionalwiki/mediawiki-mcp-server)
</details>

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for bugs, feature requests, or suggestions.

## License

This project is licensed under the GPL 2.0 License. See the [LICENSE](LICENSE) file for details.
