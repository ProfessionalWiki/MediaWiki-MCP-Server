# AGENTS.md

## Contributing new tools

New tools — and changes to existing tool descriptions, parameter documentation, or annotation hints — must follow the [tool description style guide](docs/tool-descriptions.md). The guide covers voice, depth, sibling disambiguation, canonical MediaWiki terminology, and annotation semantics.

Every tool MUST set all four `ToolAnnotations` hints explicitly: `readOnlyHint`, `destructiveHint`, `idempotentHint`, `openWorldHint`. This is not strictly required by the MCP spec but is required by OpenAI's ChatGPT developer mode, which rejects submissions missing any of the first three.

## Unit Tests

Tool handler functions (`handleXxxTool`) must be exported for testability.

Tests use Vitest with mocked mwn. Each test file mocks `getMwn` and `wikiService` before any imports that depend on them:

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

Use `createMockMwn()` from `tests/helpers/mock-mwn.ts` to create mock instances with method overrides.

## Integration Testing with MCP Inspector

The [MCP Inspector CLI](https://github.com/modelcontextprotocol/inspector) tests tools against a real wiki. Build first with `npm run build`, then:

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

## Local Wiki with Bot Passwords

Authenticated tools (create, update, delete, undelete, upload) require bot passwords. To set one up on a local MediaWiki:

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
