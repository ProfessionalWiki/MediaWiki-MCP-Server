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

One wiki entry, `readOnly: true`, `allowWikiManagement: false`. This disables `add-wiki` and `remove-wiki`, and hides the six write tools (`create-page`, `update-page`, `delete-page`, `undelete-page`, `upload-file`, `upload-file-from-url`) from `tools/list`. Result: an anonymous, read-only MCP interface.

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

- **No static credentials in `config.json`.** Any `token`, `username`, or `password` here silently serves as a fallback identity when a caller omits the header — usually defeating the point of bearer passthrough.
- **The server process sees every caller's token in flight.** Treat it as a secret-handling component: avoid verbose error logging, and don't pipe raw error objects into error-tracking services that capture arbitrary fields.
- **Single wiki only for now.** A bearer is scoped to one MediaWiki OAuth2 realm, and `set-wiki` hasn't been audited for concurrent-caller safety. Multi-wiki bearer deployment is on the roadmap.
- **Reverse proxy must forward `Authorization` intact** and strip it on untrusted inbound paths. The MCP server trusts any `Authorization: Bearer` header it sees — see [configuration.md — reverse proxy requirements](configuration.md#reverse-proxy-requirements).
- **Set `MCP_ALLOWED_HOSTS` to the hostname(s) your reverse proxy forwards** (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Without it, the SDK's DNS-rebinding check is off and non-matching `Host` headers are not rejected.

## Docker

Build and run the image locally:

```bash
docker build -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

For public deployments, set the Host-header allowlist:

```bash
docker run --rm -p 8080:8080 \
  -e MCP_ALLOWED_HOSTS=wiki.example.org \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  mediawiki-mcp-server
```

The image sets `MCP_TRANSPORT=http`, `PORT=8080`, and `MCP_BIND=0.0.0.0` (needed for container port forwarding), runs as a non-root user, and exposes `/health` for orchestration probes. No image is published; build from source.
