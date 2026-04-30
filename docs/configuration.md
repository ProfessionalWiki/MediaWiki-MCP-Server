# Advanced configuration

Covers configuration topics beyond the basic `config.json` shape documented in [README.md](../README.md#configuration): environment variable substitution, secret sources, plaintext fallback, and the `tags` field.

## Environment variable substitution

Config values support `${VAR_NAME}` syntax for referencing environment variables. This allows you to keep secrets out of your `config.json` file.

```json
{
  "defaultWiki": "my.wiki.org",
  "wikis": {
    "my.wiki.org": {
      "sitename": "My Wiki",
      "server": "https://my.wiki.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "token": "${WIKI_OAUTH_TOKEN}",
      "username": "${WIKI_USERNAME}",
      "password": "${WIKI_PASSWORD}"
    }
  }
}
```

If a referenced variable is not set:

- **Secret fields** (`token`, `username`, `password`): the server exits at startup with an error naming the wiki, the field, and the missing variable. This surfaces authentication problems up front, not as confusing failures later.
- **Non-secret fields**: the `${VAR_NAME}` text is kept as-is.

## Secret sources

As an alternative to `${VAR_NAME}`, secret fields can run an external command at startup and use its output as the secret. This lets you fetch credentials from a password manager, keyring, or secret store without writing them to disk:

```json
{
  "defaultWiki": "my.wiki.org",
  "wikis": {
    "my.wiki.org": {
      "sitename": "My Wiki",
      "server": "https://my.wiki.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "token": {
        "exec": {
          "command": "op",
          "args": ["read", "op://Private/my-wiki/oauth-token"]
        }
      }
    }
  }
}
```

The command runs directly without a shell, with `args` passed exactly as given. Its trimmed stdout becomes the secret value. A 10-second timeout applies.

If the command fails, times out, or prints nothing, the server exits at startup. Error messages identify the failing wiki and field — the secret value itself is never logged.

Any CLI that prints a credential to stdout works: 1Password's `op`, `pass`, `secret-tool`, Bitwarden's `bw`, HashiCorp Vault, or a custom script.

## Plaintext secrets

Plaintext credentials in `config.json` still work but print a one-line warning to stderr on startup. Prefer `${VAR}` or an `exec` source when possible.

## Change tags (`tags`)

The `tags` field applies one or more [change tags](https://www.mediawiki.org/wiki/Manual:Tags) to every write (create, update, delete, upload). Register and activate the tag at `Special:Tags` first — otherwise MediaWiki returns a `badtags` error and the write fails.

Accepts a string or an array of strings:

```json
{
  "wikis": {
    "my.wiki.org": {
      "tags": "mcp-server"
    }
  }
}
```

```json
{
  "wikis": {
    "my.wiki.org": {
      "tags": ["mcp-server", "automated"]
    }
  }
}
```

## Upload directories

The `upload-file` tool reads local files from the server's filesystem. Uploads are **disabled by default**: the operator must explicitly allowlist one or more directories. Every `upload-file` call returns an error until at least one directory is configured.

Enable uploads by setting one or both of:

- **`MCP_UPLOAD_DIRS` env var** — colon-separated list of absolute paths. Example: `MCP_UPLOAD_DIRS=/home/user/uploads:/var/lib/wiki-uploads`.
- **`uploadDirs` in `config.json`** — array of absolute paths at the top level:

```json
{
  "defaultWiki": "my.wiki.org",
  "uploadDirs": ["/home/user/uploads", "/var/lib/wiki-uploads"],
  "wikis": { "my.wiki.org": { "...": "..." } }
}
```

Entries from both sources are merged. Each entry is canonicalised with `fs.realpathSync` at startup — if an entry doesn't exist or isn't an absolute path, the server fails to start with a specific error.

At upload time, the supplied `filepath` must be absolute, must exist, and its symlink-resolved form must sit inside one of the configured directories. Symlinks are followed *before* the allowlist check, so a symlink pointing outside the allowlist is rejected. `..` traversal is also rejected. The resolved (canonical) path — not the caller-supplied one — is what gets uploaded.

> Dynamic client-supplied allow-listing via the MCP Roots protocol is a planned follow-up; today the allowlist is static at startup.

## Per-request bearer token (HTTP transport)

When using the Streamable HTTP transport (`MCP_TRANSPORT=http`), the server accepts a standard OAuth 2.1 `Authorization: Bearer` header on each request, as described in the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

```
Authorization: Bearer <oauth2-access-token>
```

Any MCP client that supports HTTP transport authentication can be configured to send this header. The token must be a MediaWiki OAuth2 access token obtained from `Special:OAuthConsumerRegistration/propose/oauth2` on the target wiki, with [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) installed.

**Precedence**: request header → `config.json` `token` → `config.json` `username`/`password` → anonymous. The HTTP transport refuses to start with static credentials in `config.json` unless `MCP_ALLOW_STATIC_FALLBACK=true` is set — see [deployment.md](deployment.md#shape-2--single-wiki-per-user-oauth2-bearer-passthrough) for why.

Each request builds an independent MediaWiki session using the supplied token. Token rotation and revocation take effect on the next MCP session started with the new token.

Example configuration with Claude Code:

```
claude mcp add --transport http my-wiki https://wiki.example.org/mcp \
  --header "Authorization: Bearer eyJhbGciOi..."
```

> **Note on the MCP authorization model.** The spec envisions the MCP server as a distinct OAuth resource server with its own audience, advertising `/.well-known/oauth-protected-resource` and obtaining a separate upstream token when calling MediaWiki. This server pragmatically uses MediaWiki's OAuth realm directly — the bearer token is a MediaWiki access token, and the MCP server forwards it without re-issuing. This is simpler to deploy against existing wikis but means clients must obtain a MediaWiki-audience token rather than going through an MCP-spec-compliant discovery flow.

### Reverse proxy requirements

**Trust boundary.** The server trusts any `Authorization: Bearer` header it receives without performing origin checks. Run it behind a reverse proxy that terminates client connections and forwards only intended traffic, or bind it to a trusted interface (e.g. `127.0.0.1`) — never expose the HTTP port directly on an untrusted network.

If the MCP server runs behind a reverse proxy (Caddy, nginx, Traefik), the proxy must forward the `Authorization` header to the MCP server intact. Configurations that strip or consume the header (e.g. `header_up -Authorization`, `proxy_set_header Authorization ""`, or a proxy-level basic auth handler on the MCP route) will cause the server to see no token and fall back to config/anonymous.

**Host header allowlist.** On any public deployment, set `MCP_ALLOWED_HOSTS` to the comma-separated hostnames your proxy forwards (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). This engages the SDK's DNS-rebinding check — requests to `/mcp` with a non-matching `Host` are rejected with a 403 JSON-RPC error. On a localhost bind, leaving it unset is safe (the SDK auto-allows `localhost`, `127.0.0.1`, and `[::1]`). On a public bind, leaving it unset turns the check off and the SDK logs a warning at startup.

**Origin header allowlist.** Set `MCP_ALLOWED_ORIGINS` to the browser origins allowed to call `/mcp`. An origin is the scheme, host, and (only if non-default) port — for example `https://wiki.example.org`. When the allowlist is configured and an incoming `Origin` is present but not listed, the SDK returns 403. On a localhost bind, the default allowlist is the three loopback origins on the bound port (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) so browser clients running alongside the server keep working. On a non-localhost bind, leaving it unset turns Origin validation off and the server logs a startup warning.

Matching is exact string equality against what the browser sends. These values all silently 403 every browser request:

- bare hostname (`wiki.example.org`) — missing scheme
- trailing slash (`https://wiki.example.org/`) — browsers don't include it
- path (`https://wiki.example.org/mcp`) — browsers don't include it
- explicit default port (`https://wiki.example.org:443`) — browsers drop default ports when serializing
- uppercase scheme (`HTTPS://...`) — browsers lowercase it

When in doubt, open your deployed site in a browser and log `window.location.origin` — copy that value verbatim.

Both allowlists apply only to `/mcp`. The `/health` endpoint is always reachable so container healthchecks and liveness probes (which hit `http://localhost:<port>/health`) keep working regardless of what you put in `MCP_ALLOWED_HOSTS` or `MCP_ALLOWED_ORIGINS`.

## OAuth (browser-based)

Browser-based OAuth lets you sign in to the wiki through a browser tab instead of pasting a long-lived token into `config.json`. It needs a one-time setup on the wiki by an admin; once that's done, every user of the MCP server signs in as themselves.

### For MCP server users

Add the values your wiki admin gives you to the wiki entry in `config.json`:

```json
{
	"wikis": {
		"example.org": {
			"sitename": "Example Wiki",
			"server": "https://example.org",
			"articlepath": "/wiki",
			"scriptpath": "/w",
			"oauth2ClientId": "<from your wiki admin>",
			"oauth2CallbackPort": 53117
		}
	}
}
```

What happens at runtime:

- **First call.** The server opens a browser tab to the wiki's consent page. Approve, return to your terminal — the call completes.
- **Later calls.** The server reuses the saved token. It refreshes the token automatically before it expires; you only see the consent page again if the token is revoked or you log out.
- **Where the token lives.** Linux/macOS: `~/.config/mediawiki-mcp/credentials.json`. Windows: `%APPDATA%\mediawiki-mcp\credentials.json`. The file is mode `0600` on Unix and protected by per-user `%APPDATA%` ACLs on Windows. Token values never appear in logs or tool output.

Two helper tools (stdio only):

- `oauth-status` — show which wikis you're signed into, what scopes you have, and when each token expires. Never returns token values.
- `oauth-logout` — clear the stored token. Pass `wiki: "<key>"` to log out of one wiki, or call with no arguments to log out everywhere.

If your wiki doesn't have an OAuth consumer set up, omit `oauth2ClientId`. Static credentials (`token` or `username` + `password`) and anonymous access keep working as before. If you don't know whether your wiki supports this, ask the admin.

#### Optional environment variables

- `MCP_OAUTH_CREDENTIALS_FILE` — store the credentials file somewhere other than the default path.
- `MCP_OAUTH_NO_BROWSER` — set to `1` in headless or CI environments. The server prints the consent URL to stderr instead of trying to open a browser.
- `MCP_PUBLIC_URL` — set when running the HTTP transport behind a reverse proxy that rewrites the request `Host`. Used in the OAuth discovery document and the `WWW-Authenticate` header so an OAuth-aware client can find its way back.

#### HTTP transport behaviour

When you run the HTTP transport with at least one OAuth-enabled wiki, the server publishes `/.well-known/oauth-protected-resource` so OAuth-aware MCP clients (Claude Desktop, mcp-remote, Claude Code) can discover the wiki and run the consent flow themselves. Bearer-less requests get `401` with a `WWW-Authenticate` header pointing at the discovery document. Wikis without `oauth2ClientId` are unaffected.

If `MCP_ALLOW_STATIC_FALLBACK=true` and the wiki has static credentials, bearer-less requests fall back to those credentials instead of returning 401. Use this only if you specifically want a hybrid where OAuth-aware clients sign in per user but unauthenticated callers still get service through a shared identity.

### For wiki admins: registering the OAuth consumer

The MCP server needs one OAuth 2.0 consumer per wiki. Registration requires Extension:OAuth (1.0 or later, included with MediaWiki 1.39+) and the `mwoauthproposeconsumer` user right.

1. Go to `Special:OAuthConsumerRegistration/propose/oauth2` on the wiki.
2. Fill the form:
   - **OAuth "callback URL"**: `http://127.0.0.1:<port>/oauth/callback`. Pick any free high port, for example `53117`. The MCP server users will need to set the same port number as `oauth2CallbackPort` in their `config.json`. Extension:OAuth requires an exact match between the registered URL and what the server sends, including the port.
   - **Client is confidential**: leave unchecked. The MCP server runs on user machines and uses PKCE rather than a client secret.
   - **Allowed OAuth2 grant types**: tick **Authorization code** and **Refresh token**. Leave **Client credentials** unchecked.
   - **Types of grants being requested**: pick **Request authorization for specific permissions**, then tick the categories you want the consumer to be able to request. The MCP server's tools call the wiki API on the user's behalf, so the two identity-only options aren't enough.
3. Approve the consumer at `Special:OAuthManageConsumers` if your wiki requires admin approval.
4. Hand off two values to the MCP server users:
   - The **client application key** from the confirmation page (it goes in `oauth2ClientId`).
   - The port you used in the callback URL (it goes in `oauth2CallbackPort`).

The **client application secret** is not used and can be ignored.

#### Suggested grants

Tick only the grants your users will use — see the Permissions column of the [tool table in the README](../README.md#tools) for the exact mapping. Always include **Basic rights**. **High-volume editing** is recommended if users will drive bulk edits.

Avoid granting **Manage your OAuth clients**. The MCP server does not use it, and granting it would let anyone with a token from this consumer tamper with OAuth registrations on the wiki.
