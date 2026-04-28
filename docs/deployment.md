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
- `MCP_SHUTDOWN_GRACE_MS` — milliseconds to wait for in-flight `/mcp` requests to drain on `SIGTERM` or `SIGINT` (default `10000`, max `600000`). On expiry the server exits 1 with `grace_exceeded: true`. See [Graceful shutdown](#graceful-shutdown).
- `MCP_ALLOWED_HOSTS` — comma-separated Host-header allowlist (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Set it on any non-localhost bind — without it, the SDK disables its DNS-rebinding check and logs a startup warning. Not needed on localhost binds, where the SDK auto-allows `localhost`, `127.0.0.1`, and `[::1]`. A bare hostname in `MCP_BIND` counts as non-localhost: the auto-allowlist only matches those three literals.
- `MCP_ALLOWED_ORIGINS` — comma-separated `Origin`-header allowlist (e.g. `MCP_ALLOWED_ORIGINS=https://wiki.example.org`). Requests whose `Origin` is present but not listed get a 403. On a localhost bind, defaults to the three loopback origins on the bound port (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) so local browser clients keep working. On a non-localhost bind, leaving it unset disables Origin validation and logs a startup warning. The allowlist is an exact string match — see [configuration.md — reverse proxy requirements](configuration.md#reverse-proxy-requirements) for the gotchas that silently cause every browser request to fail.
- `MCP_MAX_REQUEST_BODY` — maximum HTTP request body size (default `1mb`, matching nginx's `client_max_body_size 1m`). Raise it if `update-page` calls return 413 on legitimately large edits, or if your wiki has raised `$wgMaxArticleSize` (MediaWiki default 2 MB) and routinely edits near the ceiling. Lower it for a tighter DoS guard. Accepts body-parser size strings (`b`, `kb`, `mb`, `gb`).

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
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

The `GIT_SHA` build arg populates the `org.opencontainers.image.revision` label so `docker inspect` reports which commit the image was built from. Omit it for ad-hoc builds; the label defaults to `unknown`.

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

Every stderr line is a JSON object. Each line has `ts` (ISO-8601 UTC) and `level` (RFC 5424 severity). Prose lines add `message`; structured events add `event` instead.

### Tool calls

Every tool invocation emits one line:

```json
{"ts":"...","level":"info","event":"tool_call","tool":"get-page","wiki":"example.org","target":"Main Page","outcome":"success","duration_ms":142,"caller":"sha256:7f2a4c1d9e0b","session_id":"f4e1d2c3b4a5","upstream_status":200,"truncated":false}
```

Fields you'll filter on:

- **`outcome`** — `success` or one of seven error categories: `not_found`, `permission_denied`, `invalid_input`, `conflict`, `authentication`, `rate_limited`, `upstream_failure`.
- **`level`** — `info` for `success`, `error` for `upstream_failure`, `warning` for everything else. A `level=error` alert catches server-side failures without firing on client mistakes like a typo'd page title.
- **`caller`** — `sha256:` plus the first 12 hex chars of SHA-256 of the bearer token, or the literal string `anonymous`. Stable per token within a process; never the raw token.
- **`session_id`** — first 12 hex chars of the MCP session UUID. Omitted on stdio, which has no session concept.
- **`target`** — a single identifier extracted from the tool's input (typically a page title, search query, or URL). Omitted for tools without one: `get-pages`, `compare-pages`, `set-wiki`, `parse-wikitext`, `get-recent-changes`.

`tool_call` lines go to stderr only; they are never forwarded to the connected MCP client.

### Startup banner

One line on server boot — a snapshot of the effective configuration that's safe to paste into a support ticket:

```json
{"ts":"...","level":"info","event":"startup","version":"0.8.0","transport":"http","host":"0.0.0.0","port":8080,"auth_shape":"bearer-passthrough","default_wiki":"example.org","wikis":["example.org"],"allow_wiki_management":false,"allowed_hosts":["wiki.example.org"],"allowed_origins":["https://wiki.example.org"],"max_request_body":"1mb","upload_dirs_configured":false}
```

- **`auth_shape`** — `anonymous`, `static-credential`, or `bearer-passthrough`.
- **`host`, `port`, `allowed_hosts`, `allowed_origins`** — HTTP transport only. The two allowlists are also omitted when not configured.
- **`upload_dirs_configured`** — `true` when `uploadDirs` (config) or `MCP_UPLOAD_DIRS` (env) is set. The actual paths are not logged.
- **`max_request_body`** — HTTP transport only. The resolved `MCP_MAX_REQUEST_BODY` value.

Tokens, usernames, and passwords never appear.

### Health vs readiness

- **`GET /health`** — liveness. Returns `200 { "status": "ok" }` whenever the process is responsive. Wire this into your orchestrator's restart policy.
- **`GET /ready`** — readiness. Probes the default wiki via `action=query&meta=siteinfo` with a 3-second timeout and 5-second result cache. Wire this into traffic-shedding policy.

`/ready` response shape — 200 OK:

```json
{ "status": "ready", "wiki": "example.org", "checked_at": "..." }
```

503 Service Unavailable:

```json
{ "status": "not_ready", "wiki": "example.org", "reason": "...", "checked_at": "..." }
```

### Metrics

Set `MCP_METRICS=true` to expose `GET /metrics` on the HTTP transport in Prometheus text format. Off by default.

Sample scrape:

```
# HELP mcp_tool_calls_total Total number of MCP tool invocations, labelled by tool, wiki, and outcome.
# TYPE mcp_tool_calls_total counter
mcp_tool_calls_total{tool="get-page",wiki="example.org",outcome="success"} 142
mcp_tool_calls_total{tool="get-page",wiki="example.org",outcome="not_found"} 4

# HELP mcp_active_sessions Number of active StreamableHTTP MCP sessions.
# TYPE mcp_active_sessions gauge
mcp_active_sessions 3
```

Exposed series:

- `mcp_tool_calls_total{tool,wiki,outcome}` — counter of tool invocations.
- `mcp_tool_call_duration_seconds{tool,wiki}` — histogram of tool-call durations.
- `mcp_upstream_status_total{tool,wiki,status}` — counter of upstream MediaWiki HTTP status codes.
- `mcp_active_sessions` — gauge of active StreamableHTTP MCP sessions.
- `mcp_ready_failures_total` — counter of `/ready` probes that returned non-200.

The endpoint is **unauthenticated**. Restrict reverse-proxy access to your scrape network only — most Kubernetes-style deployments expose `/metrics` on a separate port or path that isn't routable from the public ingress.

Cardinality for `mcp_tool_calls_total` scales as `tools × wikis × outcomes` — low thousands of series in a typical deployment, comfortably within Prometheus ingest budgets. With `allowWikiManagement` enabled, treat the `wiki` label set as monotonically growing: `remove-wiki` does not retract values already exported in past samples.

### Tailing logs

Pipe stderr through `jq` or `humanlog` for live reading:

```bash
docker logs -f mediawiki-mcp-server | jq -R 'fromjson? // empty'
docker logs -f mediawiki-mcp-server | humanlog
```

## Graceful shutdown

The server registers `SIGTERM` and `SIGINT` handlers in both the HTTP and stdio transports. On signal:

1. The HTTP listener stops accepting new connections (`server.close()`), and active StreamableHTTP sessions are closed. `/health` and `/ready` keep responding until the listener finishes closing.
2. In-flight `/mcp` requests are given up to `MCP_SHUTDOWN_GRACE_MS` (default `10000`) to finish.
3. The server emits two structured stderr events:
   - `event: "shutdown"` with `signal`, `transport`, `grace_ms`, `in_flight_at_signal`, `sessions_at_signal`.
   - `event: "shutdown_complete"` with `in_flight_drained`, `sessions_closed`, `grace_exceeded`, `duration_ms`.
4. The process exits with code `0` if the drain finished within grace, `1` if `grace_exceeded` is true.

A second `SIGTERM` or `SIGINT` during drain forces an immediate exit with code `1`, so an operator can escape a hung shutdown with a second Ctrl-C or follow-up signal.

The stdio transport closes its single transport on the same signals; `MCP_SHUTDOWN_GRACE_MS` is logged as `0` since stdio has no per-call queue to drain.

This makes `docker stop`, Kubernetes pod termination, and `systemctl stop` behave correctly: the orchestrator's default `SIGTERM` triggers a drain rather than a hard kill, and the orchestrator's escalation to `SIGKILL` after its own timeout still works as the backstop. Keep `MCP_SHUTDOWN_GRACE_MS` ≤ the orchestrator's own grace (Docker's default is 10s, Kubernetes' `terminationGracePeriodSeconds` defaults to 30s) — otherwise the drain never finishes before the orchestrator escalates to `SIGKILL`.
