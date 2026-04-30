# Deployment

> [!WARNING]
> **Experimental — work in progress.** Hosted deployments support two shapes:
>
> 1. **Single-wiki, read-only, anonymous.** Simplest to deploy — no auth, no writes.
> 2. **Single-wiki, per-user OAuth2 bearer passthrough.** Each caller sends their own MediaWiki OAuth2 access token in the `Authorization` header; requests act as that caller. For writable / authenticated hosted use.
>
> Multi-wiki hosted deployments are on the roadmap but aren't ready. Don't expose a server to mutually untrusted users with a shared `config.json` token or bot password — that collapses every caller into one wiki identity, with no audit trail and no per-user rate limits.

The server can run as a remote HTTP endpoint for clients that only accept URLs (e.g. hosted LLM chat products).

## Environment

| Name | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Set to `http` for the StreamableHTTP transport (Docker default). |
| `PORT` | `3000` (Docker: `8080`) | Listen port. |
| `MCP_BIND` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen interface. Set to `0.0.0.0` outside Docker only when you need remote access. |
| `MCP_SHUTDOWN_GRACE_MS` | `10000` | Drain timeout in ms on `SIGTERM` / `SIGINT`. See [Graceful shutdown](operations.md#graceful-shutdown). |
| `MCP_ALLOWED_HOSTS` | auto on localhost | Comma-separated Host-header allowlist. See [Reverse proxy requirements](#reverse-proxy-requirements). |
| `MCP_ALLOWED_ORIGINS` | auto on localhost | Comma-separated `Origin`-header allowlist. See [Reverse proxy requirements](#reverse-proxy-requirements). |
| `MCP_MAX_REQUEST_BODY` | `1mb` | HTTP request body cap. Accepts size strings (`b`, `kb`, `mb`, `gb`). |

`MCP_MAX_REQUEST_BODY` matches nginx's `client_max_body_size 1m`. Raise it if `update-page` calls return 413 on legitimately large edits or your wiki has raised `$wgMaxArticleSize` (MediaWiki default 2 MB). Lower it for a tighter DoS guard.

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

See [per-request bearer token](#per-request-bearer-token-http-transport) for the header contract, precedence, token acquisition, and trust-boundary details.

Hosted-use notes:

- **No static credentials in `config.json`.** The HTTP transport refuses to start when any wiki has a `token` set or both `username` and `password` set — they would silently act as a fallback identity for unauthenticated callers, defeating per-caller bearer passthrough. Set `MCP_ALLOW_STATIC_FALLBACK=true` to opt into a shared-identity deployment; the server then starts with a warning naming the affected wikis.
- **The server process sees every caller's token in flight.** Treat it as a secret-handling component: avoid verbose error logging, and don't pipe raw error objects into error-tracking services that capture arbitrary fields.
- **Single wiki only for now.** A bearer is scoped to one MediaWiki OAuth2 realm, and `set-wiki` hasn't been audited for concurrent-caller safety. Multi-wiki bearer deployment is on the roadmap.
- **Reverse proxy must forward `Authorization` intact** and strip it on untrusted inbound paths. The MCP server trusts any `Authorization: Bearer` header it sees — see [reverse proxy requirements](#reverse-proxy-requirements).
- **Set `MCP_ALLOWED_HOSTS` to the hostname(s) your reverse proxy forwards** (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Without it, the SDK's DNS-rebinding check is off and non-matching `Host` headers are not rejected.
- **Set `MCP_ALLOWED_ORIGINS` to the public origin(s) your proxy serves** (e.g. `MCP_ALLOWED_ORIGINS=https://wiki.example.org`). Without it, Origin validation is off and browser requests with a mismatched `Origin` are not rejected.
- **`upload-file` stays off until you opt in.** Configure an allowlist via `uploadDirs` in `config.json` or the `MCP_UPLOAD_DIRS` env var — see [configuration.md — upload directories](configuration.md#upload-directories). With no allowlist, every local-upload attempt is refused.
- **OAuth-spec discovery is available** when a wiki sets `oauth2ClientId`. The server publishes `/.well-known/oauth-protected-resource` and returns `WWW-Authenticate: Bearer realm="MediaWiki MCP Server", resource_metadata="..."` on bearer-less 401s. OAuth-aware MCP clients use this to start the auth-code+PKCE dance against the wiki's authorization server. See [configuration.md — OAuth (browser-based)](configuration.md#oauth-browser-based) for the per-wiki opt-in.

## Per-request bearer token (HTTP transport)

When using the Streamable HTTP transport (`MCP_TRANSPORT=http`), the server accepts a standard OAuth 2.1 `Authorization: Bearer` header on each request, as described in the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

```
Authorization: Bearer <oauth2-access-token>
```

Any MCP client that supports HTTP transport authentication can be configured to send this header. The token must be a MediaWiki OAuth2 access token obtained from `Special:OAuthConsumerRegistration/propose/oauth2` on the target wiki, with [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) installed.

**Precedence**: request header → `config.json` `token` → `config.json` `username`/`password` → anonymous. The HTTP transport refuses to start with static credentials in `config.json` unless `MCP_ALLOW_STATIC_FALLBACK=true` is set — see [Shape 2](#shape-2--single-wiki-per-user-oauth2-bearer-passthrough) for why.

Each request builds an independent MediaWiki session using the supplied token. Token rotation and revocation take effect on the next MCP session started with the new token.

Example configuration with Claude Code:

```
claude mcp add --transport http my-wiki https://wiki.example.org/mcp \
  --header "Authorization: Bearer eyJhbGciOi..."
```

> [!NOTE]
> The spec envisions the MCP server as a distinct OAuth resource server with its own audience, advertising `/.well-known/oauth-protected-resource` and obtaining a separate upstream token when calling MediaWiki. This server pragmatically uses MediaWiki's OAuth realm directly — the bearer token is a MediaWiki access token, and the MCP server forwards it without re-issuing. This is simpler to deploy against existing wikis but means clients must obtain a MediaWiki-audience token rather than going through an MCP-spec-compliant discovery flow.

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

## Docker

The image is published at `ghcr.io/professionalwiki/mediawiki-mcp-server`. Pull and run it:

```bash
docker pull ghcr.io/professionalwiki/mediawiki-mcp-server:latest
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" \
  ghcr.io/professionalwiki/mediawiki-mcp-server:latest
```

### Tag conventions

Each release publishes the following tags (examples shown for `0.8.0`; substitute the release you want):

| Tag | Tracks | Use for |
|---|---|---|
| `0.8.0` | A specific patch release | Reproducible builds |
| `0.8` | Latest patch in `0.8` | Auto-pickup of patch releases |
| `0` | Latest release in `0.x` | Auto-pickup until the next major |
| `latest` | Most recent stable release | Trying it out, dev environments |
| `edge` | Tip of `master` | Tracking unreleased changes; no stability promise |
| `@sha256:<digest>` | Immutable digest | **Recommended for production** |

Production deployments should pin to a digest rather than a tag — tags are mutable and a `latest` reference can change underneath you.

### Verify image signature

Release builds (anything with a semver tag) are signed via [cosign](https://github.com/sigstore/cosign) keyless signing using GitHub's OIDC identity. Verify before deploying:

```bash
cosign verify ghcr.io/professionalwiki/mediawiki-mcp-server@<digest> \
  --certificate-identity-regexp 'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/.github/workflows/publish-image.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Edge images are not cosign-signed but still carry SBOM and SLSA provenance attestations. Verify them with `cosign verify-attestation` or `gh attestation verify`.

### Public deployments

Set both the Host-header and Origin allowlists:

```bash
docker run --rm -p 8080:8080 \
  -e MCP_ALLOWED_HOSTS=wiki.example.org \
  -e MCP_ALLOWED_ORIGINS=https://wiki.example.org \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  ghcr.io/professionalwiki/mediawiki-mcp-server:latest
```

The image sets `MCP_TRANSPORT=http`, `PORT=8080`, and `MCP_BIND=0.0.0.0` — `MCP_BIND` is set so container port forwarding reaches the listener, since `127.0.0.1` (the host-default) is per-netns and unreachable from the bridge network. It runs as a non-root user and exposes `/health` and `/ready` for orchestration probes.

### Build from source

For local hacking or to customize the image:

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

The `GIT_SHA` build arg populates the `org.opencontainers.image.revision` label so `docker inspect` reports which commit the image was built from. Omit it for ad-hoc builds; the label defaults to `unknown`.

## Operations

Observability (structured logs, `/health` / `/ready`, Prometheus metrics) and graceful shutdown live in [operations.md](operations.md).
