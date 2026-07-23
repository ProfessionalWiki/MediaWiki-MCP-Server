# Advanced configuration

Covers configuration topics beyond the basic `config.json` shape documented in [README.md](../README.md#configuration): the full field reference, environment variable substitution, secret sources, plaintext fallback, and the `tags` field.

## Configuration fields

### Top-level fields

| Field | Description |
|---|---|
| `allowWikiManagement` | Enables the `add-wiki` and `remove-wiki` tools. Set to `false` to freeze the list of configured wikis. Default: `true` |
| `defaultWiki` | The default wiki identifier to use (matches a key in `wikis`) |
| `wikis` | Object containing wiki configurations, keyed by domain/identifier |

### Per-wiki fields

| Field | Required | Description |
|---|---|---|
| `sitename` | Yes | Display name for the wiki |
| `server` | Yes | Base URL the MCP server uses to reach the wiki API. May be an internal hostname (e.g. `http://mediawiki.svc` in Docker). Also the host used for the server→wiki OAuth token exchange in the [hosted OAuth proxy](deployment.md#hosted-oauth-sign-in). |
| `publicServer` | No | The wiki's browser-facing public base URL (e.g. `https://wiki.example.org`), used when it differs from the internal `server`. In the [hosted OAuth proxy](deployment.md#hosted-oauth-sign-in) this is the host the user's browser is redirected to for the upstream consent screen. Falls back to `server` when unset. |
| `articlepath` | Yes | Path pattern for articles (typically `/wiki`) |
| `scriptpath` | Yes | Path to MediaWiki scripts (typically `/w`) |
| `oauth2ClientId` | No | Client key your wiki admin gives you when they register the MCP server's OAuth consumer. Opts the wiki into browser-based sign-in. See [OAuth (browser-based)](#oauth-browser-based). |
| `oauth2ClientSecret` | No | Client secret for the **confidential** OAuth consumer used by the [hosted OAuth proxy](deployment.md#hosted-oauth-sign-in); required when that proxy is enabled. |
| `oauth2CallbackPort` | No | Loopback port for the OAuth sign-in callback. Use the same port number your admin set in the consumer's callback URL. |
| `token` | No | OAuth2 access token for authenticated operations (manual token alternative to `oauth2ClientId`) |
| `username` | No | Bot username (fallback when OAuth2 is not available) |
| `password` | No | Bot password (fallback when OAuth2 is not available) |
| `private` | No | Whether the wiki requires authentication to read (default: `false`) |
| `readOnly` | No | When `true`, hides the six 🔐 write tools from `tools/list` while this wiki is active. Pairs with `allowWikiManagement: false` for a [hosted read-only endpoint](deployment.md). Default: `false` |
| `tags` | No | Change tag(s) to apply to every write (string or array). The tag must exist and be active at `Special:Tags` — see [change tags](#change-tags-tags) for details. |

URLs returned to the caller — page links, and the `server` field in `list-wikis` and `mcp://wikis` resources — are built from the wiki's public address, so an internal `server` hostname does not leak into links. If the wiki cannot be reached, they fall back to the configured `server`.

## Environment variable substitution

Config values support `${VAR_NAME}` syntax for referencing environment variables, keeping secrets out of `config.json`.

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

- **Secret fields** (`token`, `username`, `password`): the server exits at startup with an error naming the wiki, the field, and the missing variable.
- **Non-secret fields**: the `${VAR_NAME}` text is kept as-is.

## Secret sources

Secret fields can also run an external command and use its output as the secret. This lets you fetch credentials from a password manager, keyring, or secret store without writing them to disk:

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

The command runs the first time that wiki is used — not at startup — directly without a shell, with `args` passed exactly as given. Its trimmed stdout becomes the secret value. A 30-second timeout applies — long enough for an interactive unlock such as a 1Password prompt — and the result is cached for the lifetime of the server process.

If the command fails, times out, or prints nothing, the wiki cannot be used and tool calls against it return an authentication error identifying the wiki and field. Other wikis, and server startup, are unaffected. When a timeout was caused by a slow interactive unlock, approve the prompt and retry — the command re-runs on the next call against that wiki. The secret value itself is never logged.

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

Entries from both sources are merged. Each entry is canonicalised with `fs.realpathSync` at startup — if an entry doesn't exist or isn't an absolute path, the server fails to start with a specific error. The allowlist is fixed for the lifetime of the process.

At upload time, the supplied `filepath` must be absolute, must exist, and its symlink-resolved form must sit inside one of the configured directories. Symlinks are followed *before* the allowlist check, so a symlink pointing outside the allowlist is rejected. `..` traversal is also rejected. The resolved (canonical) path — not the caller-supplied one — is what gets uploaded.

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

`MCP_OAUTH_CREDENTIALS_FILE` (move the credentials file) and `MCP_OAUTH_NO_BROWSER` (print the consent URL instead of opening a browser) are in the [README environment-variable table](../README.md#environment-variables). When the HTTP transport runs behind a reverse proxy that rewrites the request `Host`, also set `MCP_PUBLIC_URL` so the OAuth discovery document and the `WWW-Authenticate` header advertise the public URL.

#### HTTP transport behaviour

Over the HTTP transport, OAuth runs through discovery and `401` challenges instead of a local browser flow, and each request carries the bearer for its target wiki. That behaviour is in [deployment.md — per-request bearer token](deployment.md#per-request-bearer-token-http-transport).

#### Hosted OAuth proxy environment variables

Setting `MCP_PUBLIC_URL` and `MCP_OAUTH_JWT_SIGNING_KEY` on the HTTP transport turns the server into an OAuth Authorization Server in front of one MediaWiki consumer, so OAuth-aware MCP clients sign in with no manual token handling. The variables and setup steps are in [deployment.md — hosted OAuth sign-in](deployment.md#hosted-oauth-sign-in).

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

## Manual OAuth2 access token

1. Navigate to `Special:OAuthConsumerRegistration/propose/oauth2` on your wiki.
2. Select "This consumer is for use only by [YourUsername]".
3. Grant the permissions your tools need — see the Permissions column in the [Tools](../README.md#tools) table.
4. After approval, copy the **Access Token** into the `token` field for that wiki in `config.json`.

> [!IMPORTANT]
> OAuth2 requires the [OAuth extension](https://www.mediawiki.org/wiki/Special:MyLanguage/Extension:OAuth) on the wiki.

## Bot password

If the OAuth extension isn't available, create a bot password at `Special:BotPasswords` and set `username` and `password` in `config.json` instead of `token`.
