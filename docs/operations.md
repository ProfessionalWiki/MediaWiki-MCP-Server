# Operations

Day-2 operational concerns for the MediaWiki MCP Server: structured logging, health and readiness probes, Prometheus metrics, log tailing, and graceful shutdown.

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
2. In-flight `/mcp` requests are given up to `MCP_SHUTDOWN_GRACE_MS` (default `10000`) to finish. The value is capped at `600000` (10 min); invalid values fall back to the default with a warning.
3. The server emits two structured stderr events:
   - `event: "shutdown"` with `signal`, `transport`, `grace_ms`, `in_flight_at_signal`, `sessions_at_signal`.
   - `event: "shutdown_complete"` with `in_flight_drained`, `sessions_closed`, `grace_exceeded`, `duration_ms`.
4. The process exits with code `0` if the drain finished within grace, `1` if `grace_exceeded` is true.

A second `SIGTERM` or `SIGINT` during drain forces an immediate exit with code `1`, so an operator can escape a hung shutdown with a second Ctrl-C or follow-up signal.

The stdio transport closes its single transport on the same signals; `MCP_SHUTDOWN_GRACE_MS` is logged as `0` since stdio has no per-call queue to drain.

This makes `docker stop`, Kubernetes pod termination, and `systemctl stop` behave correctly: the orchestrator's default `SIGTERM` triggers a drain rather than a hard kill, and the orchestrator's escalation to `SIGKILL` after its own timeout still works as the backstop. Keep `MCP_SHUTDOWN_GRACE_MS` ≤ the orchestrator's own grace (Docker's default is 10s, Kubernetes' `terminationGracePeriodSeconds` defaults to 30s) — otherwise the drain never finishes before the orchestrator escalates to `SIGKILL`.
