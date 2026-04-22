# Testing

Reference for unit tests, integration testing against a real wiki, and the local wiki setup needed to exercise authenticated tools.

> 🐋 **Docker alternative:** Replace `npm run` with `make` (e.g. `make inspector`).

## Unit tests

Tests use [Vitest](https://vitest.dev/) with mocked `mwn`. Tool handler functions (`handleXxxTool`) must be exported from their `src/tools/<name>.ts` file so tests can import them.

Each test file mocks `getMwn` and `wikiService` **before** any imports that depend on them:

```typescript
vi.mock( '../../src/common/mwn.js', () => ( { getMwn: vi.fn() } ) );
vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );
```

Use `createMockMwn()` from `tests/helpers/mock-mwn.ts` to create mock `mwn` instances with method overrides. See existing test files under `tests/` for the full pattern.

Run:

```sh
npm test           # one-shot
npm run test:watch # watch mode
```

## MCP Inspector (UI)

Test and debug the MCP server interactively without an MCP client or LLM.

```sh
npm run inspector
```

Builds in watch mode and starts the MCP Proxy server at `localhost:6277` and the Inspector UI at `http://localhost:6274`.

## MCPJam Inspector

Test and debug with a built-in MCP client and support for different LLMs.

```sh
npm run mcpjam
```

## MCP Inspector CLI (integration tests)

The [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector) exercises tools against a real wiki. Build first with `npm run build`, then:

```bash
# List all tools
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/list

# Call a tool
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method tools/call \
  --tool-name get-page \
  --tool-arg 'title=Main Page' \
  --tool-arg 'metadata=true'

# Read a resource
npx @modelcontextprotocol/inspector --cli node dist/index.js \
  --method resources/read \
  --uri 'mcp://wikis/en.wikipedia.org'
```

Each invocation starts a fresh MCP session, so `set-wiki` does not persist between calls. Set `defaultWiki` in `config.json` to target a specific wiki.

## Testing against MCP clients during development

To wire your MCP client (Claude Desktop, VS Code, Cursor, etc.) into a locally-built copy:

1. [Install](../README.md#installation) the MCP server on your MCP client.
2. Change the `command` and `args` values as shown in the [`mcp.json`](../mcp.json) file (or [`mcp.docker.json`](../mcp.docker.json) if you prefer Docker).
3. Run the `dev` command so sources recompile on change:

   ```sh
   npm run dev
   ```

## Local wiki setup (for authenticated tools)

Authenticated tools (create, update, delete, undelete, upload) require credentials. To set up bot passwords on a local MediaWiki running in Docker:

```bash
docker exec <container> php /var/www/html/w/maintenance/run.php createBotPassword \
  --appid mcp-server \
  --grants 'basic,editpage,editprotected,createeditmovepage,uploadfile,highvolume,delete' \
  <username>
```

Then add the credentials to `config.json` (copy from `config.example.json` if it doesn't exist):

```json
{
  "username": "<username>@mcp-server",
  "password": "<generated-password>"
}
```

For production auth, OAuth2 is preferred — see the [Authentication](../README.md#authentication) section in README.
