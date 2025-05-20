# MediaWiki MCP Server

An MCP (Model Context Protocol) server that enables Large Language Model (LLM) clients to interact with any MediaWiki wiki.

## Setup

Install all the required dependencies with:
```
make install
```

## Development

### [MCP Inspector](https://github.com/modelcontextprotocol/inspector)

To start the development server and the MCP Inspector:
```
make dev
```
The command will build and start the MCP Proxy server locally at port 6277 and the MCP Inspector client UI at port 6274.

### Test with LLM clients

To enable your LLM client to use this MediaWiki MCP Server, you'll need to register the MCP server in your client config (e.g. `claude_desktop_config.json` for [Claude Desktop](https://modelcontextprotocol.io/quickstart/user)). An example config is provided at `mcp.json`.
