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

Pass an optional `wiki` argument (a wiki key such as `en.wikipedia.org`, or the full `mcp://wikis/{wikiKey}` URI) to target a specific wiki on a given call. Omit it to use the `defaultWiki` set in `config.json`.

## Using a local build from your MCP client

To point an MCP client (Claude Desktop, VS Code, Cursor, etc.) at a locally-built copy of the server:

1. [Install](../README.md#installation) the server on the client.
2. Replace the `command` and `args` values with the ones from [`mcp.json`](../mcp.json) (or [`mcp.docker.json`](../mcp.docker.json) for Docker).
3. Run the `dev` command so sources recompile on save:

   ```sh
   npm run dev
   ```

## Local wiki setup (for authenticated tools)

Authenticated tools (create, update, delete, undelete, upload) need credentials.
To create a bot password on a local MediaWiki running in Docker:

```bash
docker exec <container> php /var/www/html/maintenance/run.php createBotPassword \
  --appid mcp-server \
  --grants 'basic,highvolume,editpage,editprotected,createeditmovepage,delete,uploadfile,uploadeditmovefile' \
  <username>
```

Then add the credentials to `config.json` (copy from `config.example.json` if it
doesn't exist). Use environment-variable substitution to keep secrets out of the
file:

```json
{
  "username": "${MW_BOT_USER}",
  "password": "${MW_BOT_PASSWORD}"
}
```

For production authentication, use OAuth2 — see [Authentication](../README.md#authentication).
To exercise the full browser sign-in flow of the hosted OAuth proxy end to end,
see [End-to-end testing the hosted OAuth proxy](#end-to-end-testing-the-hosted-oauth-proxy) below.

(Adjust `/var/www/html` to your wiki's install path.)

## End-to-end testing the hosted OAuth proxy

A manual, repeatable walkthrough of the full browser sign-in flow — discovery,
sign-in, upstream consent, token exchange, and an attributed write — against a
real wiki. Written so an agent (or a person) can follow it verbatim. It needs no
bundled environment: any MediaWiki container with Extension:OAuth works.

### 1. Prerequisites and the environment contract

You need a reachable MediaWiki container with **Extension:OAuth installed and
OAuth2 enabled** (OAuth2 signing keys configured on the wiki), a known admin
account, and a local build of this repo (`npm run build`). Any environment that
satisfies the contract below works.

| Variable | Meaning | Source |
|---|---|---|
| `OAUTH2_CLIENT_ID` | Consumer key → `config.json` `oauth2ClientId` | provisioning script |
| `MW_DEV_BOT_USER` / `MW_DEV_BOT_PASSWORD` | Static credentials for non-proxy auth tests | provisioning script |
| `MCP_TRUSTED_HOSTS` | Outbound SSRF-guard exemption for a loopback/private wiki | provisioning script |
| `MCP_PUBLIC_URL`, `MCP_OAUTH_JWT_SIGNING_KEY`, `PORT`, `MCP_TRANSPORT` | Proxy configuration | you |
| wiki URL + admin credentials | The environment itself | you |

### 2. Provision the consumer and bot password

```bash
set -a; eval "$( scripts/provision-dev-wiki.sh <container> )"; set +a
```

On a wiki whose Extension:OAuth is recent enough to register OAuth2 consumers
from the command line, this registers an approved OAuth 2.0 public (PKCE)
consumer whose callback matches `${MCP_PUBLIC_URL}/oauth/callback`, creates a bot
password, and exports `OAUTH2_CLIENT_ID`, `MW_DEV_BOT_USER`, `MW_DEV_BOT_PASSWORD`,
and (for a loopback wiki) `MCP_TRUSTED_HOSTS`. Override the proxy base with
`--public-url` if you run the server on a non-default port.

On an older Extension:OAuth — for example the copy bundled with the MediaWiki
1.43 LTS, whose `createOAuthConsumer.php` is OAuth1-only — the script cannot
register the consumer from the command line. It prints step-by-step instructions
to register it once in the browser at
`Special:OAuthConsumerRegistration/propose/oauth2`, after which you set
`OAUTH2_CLIENT_ID` yourself before starting the proxy.

### 3. Configure the wiki entry

In `config.json`, point the wiki at the provisioned consumer (adjust
`articlepath`/`scriptpath` to your wiki's layout):

```json
{
  "defaultWiki": "localhost:8080",
  "wikis": {
    "localhost:8080": {
      "sitename": "Dev MediaWiki",
      "server": "http://localhost:8080",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "oauth2ClientId": "${OAUTH2_CLIENT_ID}"
    }
  }
}
```

### 4. Start the proxy

```bash
export MCP_TRANSPORT=http PORT=3000 MCP_PUBLIC_URL=http://localhost:3000/mcp
export MCP_OAUTH_JWT_SIGNING_KEY="$(openssl rand -hex 32)"   # keep this FIXED across restarts
node dist/index.js
```

`MCP_TRUSTED_HOSTS` (from step 2) is already exported for a loopback wiki. A
changed signing key invalidates every issued token.

### 5. Walk the sign-in flow

Point an OAuth-aware MCP client at `http://localhost:3000/mcp` (the MCP
Inspector's HTTP mode works) and start sign-in, or drive the endpoints directly:
`GET /.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server`
(discovery) → `POST /mcp/register` (dynamic client registration) →
open `/mcp/authorize?…` in a browser → `POST /mcp/token`.

At the authorize step, **using your browser or a browser-automation tool**, sign
in as the admin account and approve the consent screen(s). Expected: the browser
returns to `http://localhost:3000/mcp/oauth/callback` and the client receives a
proxy-issued bearer token.

### 6. Verify

- Call `whoami` → expected: the signed-in admin account. (`oauth-status` is
  stdio-only and is not exposed over the HTTP proxy.)
- Call `create-page` (any title/text) → expected: success, and the new
  revision's author is the admin account — confirming the write is attributed to
  the signed-in user, not a shared identity.

### 7. Reset

- `oauth-logout` (stdio) or restart the server to drop stored tokens.
- Re-run step 2 to register a fresh consumer.
- Rotating `MCP_OAUTH_JWT_SIGNING_KEY` signs everyone out on the next start.
