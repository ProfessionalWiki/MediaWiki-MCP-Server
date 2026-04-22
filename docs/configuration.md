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
