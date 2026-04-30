# Testing

Reference for unit tests, integration testing against a real wiki, and the local wiki setup needed to exercise authenticated tools.

> [!TIP]
> 🐋 Commands that use `npm run <script>` have a Makefile equivalent — run `make <script>` instead (e.g. `make test`, `make inspector`). The MCP Inspector CLI examples below use `npx` directly and have no Makefile target.

## Unit tests

Tests use [Vitest](https://vitest.dev/). Each tool exports a `Tool<TSchema>` descriptor from `src/tools/<name>.ts`; tests import the descriptor and route through `dispatch( descriptor, ctx )` from `src/runtime/dispatcher.js`.

Build a `ToolContext` per test via `fakeContext()` from `tests/helpers/fakeContext.ts`. Override only the slices the test exercises — by default unstubbed methods throw, so tests fail loudly when they reach for something they didn't mean to:

```typescript
import { describe, it, expect, vi } from 'vitest';
import { fakeContext } from '../helpers/fakeContext.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { getPage } from '../../src/tools/get-page.js';

it( 'returns page source', async () => {
	const mwn = createMockMwn( { read: vi.fn().mockResolvedValue( /* … */ ) } );
	const ctx = fakeContext( { mwn: async () => mwn as never } );
	const result = await getPage.handle( { title: 'Foo' /* … */ }, ctx );
	// assertions
} );

it( 'maps missingtitle to not_found via the dispatcher', async () => {
	const mwn = createMockMwn( { read: vi.fn().mockRejectedValue( /* … */ ) } );
	const ctx = fakeContext( { mwn: async () => mwn as never } );
	const result = await dispatch( getPage, ctx )( { title: 'Missing' } );
	// assertions
} );
```

Happy-path tests typically call `descriptor.handle( args, ctx )` directly. Error-classification tests go through `dispatch( descriptor, ctx )` so the dispatcher's classification + special-case + format.error pipeline runs end-to-end.

Use `createMockMwn()` from `tests/helpers/mock-mwn.ts` to create mock `mwn` instances with method overrides. See existing test files under `tests/tools/` for the full pattern.

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

Starts a watch-mode TypeScript build plus the MCP Proxy server on port `6277` and the Inspector UI at http://localhost:6274.

## MCPJam Inspector

Like the MCP Inspector, but with a built-in MCP client that can drive the server against different LLMs — useful for checking how a given LLM actually calls the tools.

```sh
npm run mcpjam
```

For tools that surface a domain-specific syntax to the LLM (query tools, parser-function wrappers), spot-check the description with a few natural-language prompts here before merge — this catches description gaps that unit tests can't.

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

## Using a local build from your MCP client

To point an MCP client (Claude Desktop, VS Code, Cursor, etc.) at a locally-built copy of the server:

1. [Install](../README.md#installation) the server on the client.
2. Replace the `command` and `args` values with the ones from [`mcp.json`](../mcp.json) (or [`mcp.docker.json`](../mcp.docker.json) for Docker).
3. Run the `dev` command so sources recompile on save:

   ```sh
   npm run dev
   ```

## Local wiki setup (for authenticated tools)

Authenticated tools (create, update, delete, undelete, upload) need credentials. To create bot passwords on a local MediaWiki running in Docker:

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

For production authentication, use OAuth2 — see [Authentication](../README.md#authentication) in the README.
