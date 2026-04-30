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

Browser-based OAuth lets users authenticate without pasting a token into `config.json`. It is opt-in per wiki.

### Register an OAuth consumer on the wiki

1. Visit `Special:OAuthConsumerRegistration/propose/oauth2` on the wiki. Extension:OAuth ≥ 1.0 (MediaWiki ≥ 1.39) is required.
2. Fill in the form fields specific to the OAuth flow:
   - **OAuth "callback URL"**: `http://127.0.0.1:<port>/oauth/callback`. Pick a fixed high port that's likely to be free on your machine — `53117` is a reasonable default; any value in the dynamic-port range (49152–65535) works. Extension:OAuth's OAuth 2.0 implementation **exact-matches** the redirect URI on every authorization request and explicitly does not honour RFC 8252 §7.3 loopback flexibility (the form's help text says "Unlike OAuth 1.0a, this URL is exactly matched"). The same port number must also go in `oauth2CallbackPort` in `config.json` — see below. The "Allow consumer to specify a callback in requests, and use 'callback' URL above as a required prefix" checkbox is OAuth 1.0a-only; for OAuth 2.0 consumers it has no effect.
   - **Client is confidential**: ❌ leave unchecked. The MCP server is a public client and uses PKCE (RFC 7636) in place of a client secret. Marking the consumer confidential would make the wiki demand a `client_secret` on every token-endpoint exchange, and the dance would fail with `invalid_client` because the server does not (and cannot safely) hold a secret on a user's machine.
   - **Allowed OAuth2 grant types**:
     - ✅ **Authorization code** — required; this is the user-delegated flow the MCP server drives.
     - ✅ **Refresh token** — recommended; lets the server renew an expiring access token without prompting the user again. Disable only if your security policy requires re-authentication on every token expiry.
     - ❌ **Client credentials** — leave unchecked. This grant is for confidential clients authenticating as themselves with no user; it doesn't apply to a public client doing user-delegated auth, and granting it would let any holder of the `client_id` impersonate the consumer without user consent.
   - **Types of grants being requested**: pick **Request authorization for specific permissions**. The two identity-only options stop short of API access; the MCP server's tools all need to call the wiki API on the user's behalf. This option opens a checklist of grant categories — tick the ones you want the consumer to be able to request. Suggested minimum:
     - **Basic rights** — always required (anonymous reads, basic profile).
     - **Edit existing pages** + **Create, edit, and move pages** — needed for `update-page`, `create-page`, `delete-page`, `undelete-page`.
     - **High-volume editing** — recommended if the MCP server is going to drive bulk edits without rate-limiting prompts.
     - **Upload new files** + **Upload, replace, and move files** — needed for `upload-file`, `upload-file-from-url`, `update-file`, `update-file-from-url`.
   - Tools whose grants the user has not approved at consent time will return `permission_denied`; you can grant only what you want to exercise.
3. Approve the consumer at `Special:OAuthManageConsumers` (admin step, depending on your wiki's policy).
4. From the confirmation page, copy the **client application key** — Extension:OAuth's UI label for the OAuth 2.0 `client_id`. This is the value that goes into `oauth2ClientId` below. Disregard the **client application secret**: it is only used by confidential clients (which this server isn't), and it has no `WikiConfig` field to live in.

### Configure the MCP server

Add `oauth2ClientId` and `oauth2CallbackPort` to the wiki entry:

```json
{
	"wikis": {
		"example.org": {
			"sitename": "Example Wiki",
			"server": "https://example.org",
			"articlepath": "/wiki",
			"scriptpath": "/w",
			"oauth2ClientId": "<client_id from step 4>",
			"oauth2CallbackPort": 53117
		}
	}
}
```

Presence of `oauth2ClientId` opts the wiki into OAuth. Wikis without it continue to use static credentials (`token` / `username` + `password`) or anonymous access.

`oauth2CallbackPort` must match the port in the registered callback URL on the wiki side. The stdio runtime binds `127.0.0.1:<oauth2CallbackPort>` for the OAuth callback. Omit this field only if the wiki's authorization server honours RFC 8252 §7.3 loopback flexibility — Extension:OAuth's OAuth 2.0 implementation does not, so for any MediaWiki wiki you must set it.

### How it works

On **HTTP transport** the server publishes `/.well-known/oauth-protected-resource` (RFC 9728) listing the wiki's authorization server. OAuth-aware MCP clients (Claude Desktop, mcp-remote, Claude Code) follow this metadata to drive auth-code + PKCE against the wiki and send `Authorization: Bearer <token>` on each call. Bearer-less requests against an OAuth-enabled wiki receive `401 Unauthorized` with a `WWW-Authenticate: Bearer realm="MediaWiki MCP Server", resource_metadata="..."` header so the client can discover the AS and start the dance.

On **stdio transport** the server itself runs the auth-code + PKCE dance: opens a browser, runs a loopback HTTP listener on `127.0.0.1:<random-port>` for the callback, exchanges the code for tokens, and stores `{access_token, refresh_token, expires_at, scopes, obtained_at}` in:

- Linux/macOS: `$XDG_CONFIG_HOME/mediawiki-mcp/credentials.json` or `~/.config/mediawiki-mcp/credentials.json`
- Windows: `%APPDATA%\mediawiki-mcp\credentials.json`

The file is mode 0600 on Unix; on Windows the per-user `%APPDATA%` ACLs apply. Subsequent stdio calls reuse the stored token, refreshing it automatically within 60 seconds of expiry.

### Optional environment variables

- `MCP_OAUTH_CREDENTIALS_FILE` — Override the default credentials path.
- `MCP_OAUTH_NO_BROWSER` — Set to `1` to skip `open()` (the server logs the URL to stderr instead). Useful in headless environments and CI.
- `MCP_PUBLIC_URL` — Override the request-derived URL used in the protected-resource doc's `resource` field. Set this when running behind a proxy that rewrites the request `Host`.

### Inspecting and resetting stored tokens (stdio)

Two MCP tools, hidden on HTTP transport:

- `oauth-status` — returns the wikis with stored tokens, their scopes, and expiry. Never returns token values.
- `oauth-logout` — removes stored tokens. Pass `wiki: "<key>"` to remove only that wiki, or call with no arguments to remove all.

### What if my wiki doesn't have Extension:OAuth?

Don't set `oauth2ClientId`. Static credentials (`token`, `username` + `password`) continue to work as before.

### Interaction with `MCP_ALLOW_STATIC_FALLBACK`

On HTTP transport, the existing `MCP_ALLOW_STATIC_FALLBACK` guard determines whether bearer-less requests fall back to static credentials. Two configurations:

- `oauth2ClientId` set, `MCP_ALLOW_STATIC_FALLBACK` unset: bearer-less requests get 401 + WWW-Authenticate. Pure OAuth.
- `oauth2ClientId` set, `MCP_ALLOW_STATIC_FALLBACK=true`, AND wiki has static creds: bearer-less requests use static creds (legacy behaviour). The discovery doc is still published; OAuth-aware clients can opt in.
