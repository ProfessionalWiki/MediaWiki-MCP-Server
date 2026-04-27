# Deployment

> **Experimental — work in progress.** Hosted deployments support two shapes:
>
> 1. **Single-wiki, read-only, anonymous.** Simplest to deploy — no auth, no writes.
> 2. **Single-wiki, per-user OAuth2 bearer passthrough.** Each caller sends their own MediaWiki OAuth2 access token in the `Authorization` header; requests act as that caller. For writable / authenticated hosted use.
>
> Multi-wiki hosted deployments are on the roadmap but aren't ready. Don't expose a server to mutually untrusted users with a shared `config.json` token or bot password — that collapses every caller into one wiki identity, with no audit trail and no per-user rate limits.

The server can run as a remote HTTP endpoint for clients that only accept URLs (e.g. hosted LLM chat products).

## Environment

- `MCP_TRANSPORT=http` — switch to the StreamableHTTP transport (the Dockerfile sets this by default).
- `PORT` — listen port (default `3000` locally, `8080` in Docker).
- `MCP_BIND` — listen interface (default `127.0.0.1`; the Dockerfile overrides to `0.0.0.0` so container port forwarding reaches the listener). Set to `0.0.0.0` outside Docker only when you need remote access.
- `MCP_ALLOWED_HOSTS` — comma-separated Host-header allowlist (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Set it on any non-localhost bind — without it, the SDK disables its DNS-rebinding check and logs a startup warning. Not needed on localhost binds, where the SDK auto-allows `localhost`, `127.0.0.1`, and `[::1]`. A bare hostname in `MCP_BIND` counts as non-localhost: the auto-allowlist only matches those three literals.
- `MCP_ALLOWED_ORIGINS` — comma-separated `Origin`-header allowlist (e.g. `MCP_ALLOWED_ORIGINS=https://wiki.example.org`). Requests whose `Origin` is present but not listed get a 403. On a localhost bind, defaults to the three loopback origins on the bound port (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) so local browser clients keep working. On a non-localhost bind, leaving it unset disables Origin validation and logs a startup warning. The allowlist is an exact string match — see [configuration.md — reverse proxy requirements](configuration.md#reverse-proxy-requirements) for the gotchas that silently cause every browser request to fail.

## Shape 1 — Single-wiki, read-only, anonymous

```json
{
  "allowWikiManagement": false,
  "defaultWiki": "example.org",
  "wikis": {
    "example.org": {
      "sitename": "Example Wiki",
      "server": "https://example.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "readOnly": true
    }
  }
}
```

One wiki entry, `readOnly: true`, `allowWikiManagement: false`. This hides `add-wiki`, `remove-wiki`, and the six write tools (`create-page`, `update-page`, `delete-page`, `undelete-page`, `upload-file`, `upload-file-from-url`) from `tools/list`. With only one wiki configured, `set-wiki` is also hidden — there's nothing to switch to. Result: an anonymous, read-only MCP interface.

Don't set `token`, `username`, or `password` — there's no per-caller authentication in this shape, so static credentials would become shared across every caller.

Place the server behind a reverse proxy that terminates TLS and applies rate limiting. Cloudflare, nginx, and Caddy all work.

## Shape 2 — Single-wiki, per-user OAuth2 bearer passthrough

```json
{
  "allowWikiManagement": false,
  "defaultWiki": "example.org",
  "wikis": {
    "example.org": {
      "sitename": "Example Wiki",
      "server": "https://example.org",
      "articlepath": "/wiki",
      "scriptpath": "/w"
    }
  }
}
```

One wiki entry, `allowWikiManagement: false`, no static credentials. Each HTTP request carries `Authorization: Bearer <token>`, which the server forwards to MediaWiki as that caller's OAuth2 access token. Writes are attributable to the caller, MediaWiki's per-user rate limits apply, and `tools/list` exposes the full write surface.

See [configuration.md — per-request bearer token](configuration.md#per-request-bearer-token-http-transport) for the header contract, precedence, token acquisition, and trust-boundary details.

Hosted-use notes:

- **No static credentials in `config.json`.** The HTTP transport refuses to start when any wiki has a `token` set or both `username` and `password` set — they would silently act as a fallback identity for unauthenticated callers, defeating per-caller bearer passthrough. Set `MCP_ALLOW_STATIC_FALLBACK=true` to opt into a shared-identity deployment; the server then starts with a warning naming the affected wikis.
- **The server process sees every caller's token in flight.** Treat it as a secret-handling component: avoid verbose error logging, and don't pipe raw error objects into error-tracking services that capture arbitrary fields.
- **Single wiki only for now.** A bearer is scoped to one MediaWiki OAuth2 realm, and `set-wiki` hasn't been audited for concurrent-caller safety. Multi-wiki bearer deployment is on the roadmap.
- **Reverse proxy must forward `Authorization` intact** and strip it on untrusted inbound paths. The MCP server trusts any `Authorization: Bearer` header it sees — see [configuration.md — reverse proxy requirements](configuration.md#reverse-proxy-requirements).
- **Set `MCP_ALLOWED_HOSTS` to the hostname(s) your reverse proxy forwards** (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Without it, the SDK's DNS-rebinding check is off and non-matching `Host` headers are not rejected.
- **Set `MCP_ALLOWED_ORIGINS` to the public origin(s) your proxy serves** (e.g. `MCP_ALLOWED_ORIGINS=https://wiki.example.org`). Without it, Origin validation is off and browser requests with a mismatched `Origin` are not rejected.
- **`upload-file` stays off until you opt in.** Configure an allowlist via `uploadDirs` in `config.json` or the `MCP_UPLOAD_DIRS` env var — see [configuration.md — upload directories](configuration.md#upload-directories). With no allowlist, every local-upload attempt is refused.

## Docker

Build and run the image locally:

```bash
docker build -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

For public deployments, set both the Host-header and Origin allowlists:

```bash
docker run --rm -p 8080:8080 \
  -e MCP_ALLOWED_HOSTS=wiki.example.org \
  -e MCP_ALLOWED_ORIGINS=https://wiki.example.org \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  mediawiki-mcp-server
```

The image sets `MCP_TRANSPORT=http`, `PORT=8080`, and `MCP_BIND=0.0.0.0` (needed for container port forwarding), runs as a non-root user, and exposes `/health` for orchestration probes. No image is published; build from source.

## Observability

The server emits one JSON object per stderr line. Reserved keys: `ts` (ISO-8601 UTC), `level` (RFC 5424), `message` (omitted when empty), and — for non-message events — `event`.

### Tool calls

Every tool invocation produces one line:

```json
{"ts":"...","level":"info","event":"tool_call","tool":"get-page","wiki":"example.org","target":"Main Page","outcome":"success","duration_ms":142,"caller":"sha256:7f2a4c1d9e0b","session_id":"f4e1d2c3b4a5","upstream_status":200,"truncated":false}
```

`outcome` is one of `success`, `not_found`, `permission_denied`, `invalid_input`, `conflict`, `authentication`, `rate_limited`, `upstream_failure`. `level` is `error` for `upstream_failure`, `warning` for the other six error categories, `info` for `success` — so a `level=error` filter catches actual server-side problems without firing on every "user typoed a page title".

`caller` is `sha256:` plus the first 12 hex chars of SHA-256 of the bearer token, or the literal string `anonymous`. Stable per token within a process; never the raw token.

`session_id` is the first 12 hex chars of the MCP session ID. Omitted for stdio transport (which has no concept of sessions).

`target` is omitted when no single identifier applies (e.g. `get-pages`, `compare-pages`, `set-wiki`, `parse-wikitext`, `get-recent-changes`).

### Startup banner

One line on server boot:

```json
{"ts":"...","level":"info","event":"startup","version":"0.7.0","transport":"http","host":"0.0.0.0","port":8080,"auth_shape":"bearer-passthrough","default_wiki":"example.org","wikis":["example.org"],"allow_wiki_management":false,"allowed_hosts":["wiki.example.org"],"allowed_origins":["https://wiki.example.org"],"upload_dirs_configured":false}
```

`auth_shape` is one of `anonymous`, `static-credential`, `bearer-passthrough`. No tokens, usernames, or passwords appear in any field.

`host`, `port`, `allowed_hosts`, and `allowed_origins` appear only on HTTP transport; for stdio they are omitted. `allowed_hosts` and `allowed_origins` are themselves omitted within HTTP mode when no allowlist is configured.

`upload_dirs_configured` is a boolean indicating whether the `uploadDirs` config field or `MCP_UPLOAD_DIRS` env var is set; the actual paths are not logged.

### Health vs readiness

- `GET /health` — liveness only. Returns `200 { "status": "ok" }` whenever the process is responsive. Use this for orchestrator restart decisions.
- `GET /ready` — readiness. Probes the default wiki via `action=query&meta=siteinfo` (3-second timeout, 5-second cache). Returns `200 { "status": "ready", "wiki": "example.org", "checked_at": "..." }` when reachable, `503 { "status": "not_ready", "wiki": "example.org", "reason": "...", "checked_at": "..." }` otherwise. Use this for traffic-shedding decisions.

### Tailing logs

JSON output is the only format the server emits. To read live:

```bash
docker logs -f mediawiki-mcp-server | jq -R 'fromjson? // empty'
# or
docker logs -f mediawiki-mcp-server | humanlog
```
