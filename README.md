# MediaWiki MCP Server

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Feature

### Tools

> 🔑 **Requires OAuth 2.0 token.** Request one at the `Special:OAuthConsumerRegistration/propose/oauth2` page on the wiki.

| Name | Description | 
|---|---|
| `create-page` 🔑 | Create a new wiki page. |
| `get-file` | Returns the standard file object for a file page. |
| `get-page` | Returns the standard page object for a wiki page. |
| `get-page-history` | Returns information about the latest revisions to a wiki page. |
| `search-page` | Search wiki page titles and contents for the provided search terms. |
| `set-wiki` | Set the wiki to use for the current session. |
| `update-page` 🔑 | Update an existing wiki page. |

### Environment variables

| Name | Description |
|---|---|
| `WIKI_SERVER` | Domain of the wiki (e.g. `https://en.wikipedia.org`) |
| `ARTICLE_PATH` | Article path of the wiki (e.g. `/wiki`) |
| `SCRIPT_PATH` | Script path of the wiki (e.g. `/w`) |
| `OAUTH_TOKEN` | OAuth token from the [OAuth extension](https://www.mediawiki.org/wiki/Special:MyLanguage/Extension:OAuth) |

## Development

> 🐋 Replace the `npm run` part of the command with `make` (e.g. `make dev`) for a Docker container setup.

### [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

To start the development server and the MCP Inspector:
```sh
npm run dev
```

The command will build and start the MCP Proxy server locally at port `6277` and the MCP Inspector client UI at port `6274`.

### Test with LLM clients

To enable your LLM client to use this MediaWiki MCP Server for local development: 

1. Register the MCP server in your client config (e.g. `claude_desktop_config.json` for [Claude Desktop](https://modelcontextprotocol.io/quickstart/user)). An example config is provided at `mcp.json`.
2. Run the watch command so that the source will be compiled whenever there is a change:

	```sh
	npm run watch
	```
