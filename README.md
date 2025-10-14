# MediaWiki MCP Server
[![smithery badge](https://smithery.ai/badge/@ProfessionalWiki/mediawiki-mcp-server)](https://smithery.ai/server/@ProfessionalWiki/mediawiki-mcp-server)

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Feature

### Tools

> 🔐 **Requires OAuth 2.0 token in configuration:** Obtained via `Special:OAuthConsumerRegistration/propose/oauth2` provided by the [OAuth extension](https://www.mediawiki.org/wiki/Special:MyLanguage/Extension:OAuth). Select "This consumer is for use only by UserName"

| Name | Description | 
|---|---|
| `create-page` 🔐 | Create a new wiki page. |
| `get-file` | Returns the standard file object for a file page. |
| `get-page` | Returns the standard page object for a wiki page. |
| `get-page-history` | Returns information about the latest revisions to a wiki page. |
| `search-page` | Search wiki page titles and contents for the provided search terms. |
| `set-wiki` | Set the wiki to use for the current session. |
| `update-page` 🔐 | Update an existing wiki page. |
| `upload-file` 🔐 | Uploads a file to the wiki from the local disk. |
| `upload-file-from-url` 🔐 | Uploads a file to the wiki from a web URL. |

### Environment variables
| Name | Description | Default |
|---|---|---|
| `CONFIG` | Path to your configuration file | `config.json` |
| `MCP_TRANSPORT` | Type of MCP server transport (`stdio` or `http`) | `stdio` |
| `PORT` | Port used for StreamableHTTP transport | `3000` |

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

## Contributing

Contributions are welcome! Please feel free to submit a pull request or open an issue for bugs, feature requests, or suggestions.

## License

This project is licensed under the GPL 2.0 License. See the [LICENSE](LICENSE) file for details.
