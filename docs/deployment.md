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
- **OAuth-spec discovery is available** when a wiki sets `oauth2ClientId`. The server publishes `/.well-known/oauth-protected-resource` and returns `WWW-Authenticate: Bearer realm="MediaWiki MCP Server", resource_metadata="..."` on bearer-less 401s. OAuth-aware MCP clients use this to start the auth-code+PKCE dance against the wiki's authorization server. See [configuration.md — OAuth (browser-based)](configuration.md#oauth-browser-based) for the per-wiki opt-in.

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
