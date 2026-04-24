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

The `upload-file` tool reads local files from the server's filesystem and uploads them to the wiki. By default **no directories are allowed**, and every `upload-file` call will return a clear error telling the operator how to configure an allowlist.

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

At upload time, the supplied `filepath` is validated: it must be absolute, must exist, and its `fs.realpath`-resolved form must sit inside one of the configured directories. Symlink escapes and `..` traversal are rejected. The resolved path (not the caller-supplied one) is passed to the wiki.

> Dynamic client-supplied allow-listing via the MCP Roots protocol is a planned follow-up; today the allowlist is static at startup.

## Per-request bearer token (HTTP transport)

When using the Streamable HTTP transport (`MCP_TRANSPORT=http`), the server accepts a standard OAuth 2.1 `Authorization: Bearer` header on each request, as described in the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

```
Authorization: Bearer <oauth2-access-token>
```

Any MCP client that supports HTTP transport authentication can be configured to send this header. The token must be a MediaWiki OAuth2 access token obtained from `Special:OAuthConsumerRegistration/propose/oauth2` on the target wiki, with [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) installed.

**Precedence**: request header → `config.json` `token` → `config.json` `username`/`password` → anonymous. When no `Authorization` header is present, the server falls back to the static credentials in `config.json`, preserving existing behaviour.

Each request builds an independent MediaWiki session using the supplied token. Token rotation and revocation take effect immediately on the next request.

Example configuration with Claude Code:

```
claude mcp add --transport http my-wiki https://wiki.example.org/mcp \
  --header "Authorization: Bearer eyJhbGciOi..."
```

> **Note on the MCP authorization model.** The spec envisions the MCP server as a distinct OAuth resource server with its own audience, advertising `/.well-known/oauth-protected-resource` and obtaining a separate upstream token when calling MediaWiki. This server pragmatically uses MediaWiki's OAuth realm directly — the bearer token is a MediaWiki access token, and the MCP server forwards it without re-issuing. This is simpler to deploy against existing wikis but means clients must obtain a MediaWiki-audience token rather than going through an MCP-spec-compliant discovery flow.

### Reverse proxy requirements

**Trust boundary.** The server trusts any `Authorization: Bearer` header it receives without performing origin checks. Run it behind a reverse proxy that terminates client connections and forwards only intended traffic, or bind it to a trusted interface (e.g. `127.0.0.1`) — never expose the HTTP port directly on an untrusted network.

If the MCP server runs behind a reverse proxy (Caddy, nginx, Traefik), the proxy must forward the `Authorization` header to the MCP server intact. Configurations that strip or consume the header (e.g. `header_up -Authorization`, `proxy_set_header Authorization ""`, or a proxy-level basic auth handler on the MCP route) will cause the server to see no token and fall back to config/anonymous.
