# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Development Commands

### Build and Development
- `npm run build` - Compile TypeScript to JavaScript in the `dist/` directory
- `npm run watch` - Watch for changes and auto-compile TypeScript
- `npm run dev` - Start development server with MCP Inspector (ports 6274 for UI, 6277 for proxy)
- `npm run dev:streamableHttp` - Start development server with HTTP transport
- `npm run lint` - Run ESLint with caching on source files
- `npm run start` - Run the compiled server (requires prior build)
- `npm run start:streamableHttp` - Run server with HTTP transport

### Docker Development
Replace `npm run` with `make` for any command (e.g., `make dev`, `make build`, `make lint`). Docker commands use Node.js v22.

### Testing
- `npm run test` - Currently placeholder (no tests implemented)

## Architecture Overview

This is a Model Context Protocol (MCP) server that provides LLM clients with tools to interact with MediaWiki wikis.

### Core Components

**Entry Point** (`src/index.ts`):
- Determines transport type via `MCP_TRANSPORT` environment variable
- Supports both `stdio` (default) and `http` transports

**Server Creation** (`src/server.ts`):
- Creates MCP server instance with name and version
- Registers all available tools via `registerAllTools()`

**Configuration System** (`src/common/config.ts`):
- Multi-wiki support with JSON configuration
- Default config includes Wikipedia and localhost instances
- Session-scoped current wiki selection
- OAuth 1.0a and OAuth 2.0 token management for authenticated operations

**Tools Architecture** (`src/tools/`):
- Modular tool registration system
- Each tool is a separate module that registers with the MCP server
- Available tools: `get-page`, `get-page-history`, `search-page`, `set-wiki`, `update-page`, `get-file`, `create-page`
- Tools requiring authentication are marked with 🔐 in documentation

### Configuration

**Environment Variables**:
- `CONFIG` - Path to configuration file (default: `config.json`)
- `MCP_TRANSPORT` - Transport type: `stdio` or `http` (default: `stdio`)
- `PORT` - HTTP transport port (default: `3000`)

**Wiki Configuration** (`config.json`):
```json
{
  "defaultWiki": "en.wikipedia.org",
  "wikis": {
    "en.wikipedia.org": {
      "sitename": "Wikipedia",
      "server": "https://en.wikipedia.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "token": null
    }
  }
}
```

### Key Functions

**Configuration Management** (`src/common/config.ts`):
- `getCurrentWikiConfig()` - Get current wiki configuration
- `setCurrentWiki(wiki)` - Switch to different configured wiki
- `getAllWikis()` - Get all configured wikis
- `oauthToken()` - Get OAuth token for current wiki

### Development Notes

- Uses TypeScript with ES2022 target and NodeNext modules
- ESLint configuration based on Wikimedia TypeScript standards
- No test framework currently configured
- OAuth tokens required for write operations (create-page, update-page)
- OAuth setup via `Special:OAuthConsumerRegistration/propose/oauth2` with OAuth extension

### OAuth Authentication

**Supported OAuth Versions**:
- OAuth 1.0a (legacy support)
- OAuth 2.0 (recommended)

**OAuth 2.0 Setup**:
1. Register application at `Special:OAuthConsumerRegistration/propose/oauth2`
2. Required grants: `basic`, `createeditmovedpage`, `editpage`
3. Add `clientId`, `clientSecret`, and `token` (JWT) to wiki configuration

**Known Issues**:
- MediaWiki REST API has OAuth 2.0 + CSRF token integration bug
- Write operations (create-page, update-page) automatically fall back to legacy Action API
- Read operations work normally with REST API
- Legacy Action API works correctly with OAuth 2.0 authentication

### MCP Integration

**Local Development**: Use `mcp.json` configuration for MCP clients
**Production**: Install via npm package `@professional-wiki/mediawiki-mcp-server`

The server automatically handles tool registration and provides schema definitions for all available MediaWiki operations.