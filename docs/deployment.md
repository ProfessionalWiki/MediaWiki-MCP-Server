# Deployment

> [!WARNING]
> **Experimental — work in progress.** Hosted deployments support three shapes:
>
> 1. **Single-wiki, read-only, anonymous.** Simplest to deploy — no auth, no writes.
> 2. **Single-wiki, per-user OAuth2 bearer passthrough.** Each caller sends their own MediaWiki OAuth2 access token in the `Authorization` header; requests act as that caller. For writable / authenticated hosted use.
> 3. **Single-wiki, hosted server-mediated OAuth (proxy).** The server is itself an OAuth 2.1 Authorization Server toward MCP clients, brokering one pre-registered MediaWiki consumer. Zero-install for the client — point any OAuth-aware MCP client at `https://<wiki>/mcp` and each user signs in as themselves. For writable hosted use without handing callers a raw MediaWiki token.
>
> Multi-wiki hosted deployments are on the roadmap but aren't ready. Don't expose a server to mutually untrusted users with a shared `config.json` token or bot password — that collapses every caller into one wiki identity, with no audit trail and no per-user rate limits.

The server can run as a remote HTTP endpoint for clients that only accept URLs (e.g. hosted LLM chat products).

## Endpoint

MCP clients connect to the `/mcp` path on the configured host and port. For the local default:

    http://localhost:3000/mcp

For the Docker default:

    http://localhost:8080/mcp

Behind a reverse proxy, the same shape applies:

    https://wiki.example.org/mcp

The path is fixed and not configurable.

## Environment

| Name | Default | Description |
|---|---|---|
| `MCP_TRANSPORT` | `stdio` | Set to `http` for the StreamableHTTP transport (Docker default). |
| `PORT` | `3000` (Docker: `8080`) | Listen port. |
| `MCP_BIND` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen interface. Set to `0.0.0.0` outside Docker only when you need remote access. |
| `MCP_SHUTDOWN_GRACE_MS` | `10000` | Drain timeout in ms on `SIGTERM` / `SIGINT`. See [Graceful shutdown](operations.md#graceful-shutdown). |
| `MCP_ALLOWED_HOSTS` | auto on localhost | Comma-separated Host-header allowlist. See [Reverse proxy requirements](#reverse-proxy-requirements). |
| `MCP_ALLOWED_ORIGINS` | auto on localhost | Comma-separated `Origin`-header allowlist. See [Reverse proxy requirements](#reverse-proxy-requirements). |
| `MCP_TRUSTED_HOSTS` | unset | Comma-separated **outbound** SSRF-guard exemptions for internal destinations (e.g. `mediawiki.svc`). See [Outbound SSRF guard](#outbound-ssrf-guard). |
| `MCP_MAX_REQUEST_BODY` | `1mb` | HTTP request body cap. Accepts size strings (`b`, `kb`, `mb`, `gb`). |
| `MCP_PUBLIC_URL` | unset | The proxy's public issuer/base, e.g. `https://wiki.example.org/mcp`. Enables the hosted OAuth proxy when set alongside `MCP_OAUTH_JWT_SIGNING_KEY` and a default wiki with `oauth2ClientId`. See [Shape 3](#shape-3--single-wiki-hosted-server-mediated-oauth-proxy). |
| `MCP_OAUTH_JWT_SIGNING_KEY` | unset | Secret (≥32 chars) the proxy signs its issued access/refresh JWTs and consent cookies with. Required for the proxy. Keep it **fixed** so tokens survive a restart. See [Shape 3](#shape-3--single-wiki-hosted-server-mediated-oauth-proxy). |
| `MCP_OAUTH_TOKEN_TTL` | `55m` | Lifetime of a proxy-minted access JWT. Must be shorter than the upstream 30-day refresh window. Duration grammar (`55m`/`1h`/`30d`, or bare seconds). |
| `MCP_OAUTH_CONSENT_TTL` | `30d` | Lifetime of the signed consent cookie that lets a returning user skip the consent page. Same duration grammar. |

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

One wiki entry, `readOnly: true`, `allowWikiManagement: false`. This hides `add-wiki`, `remove-wiki`, and the six write tools (`create-page`, `update-page`, `delete-page`, `undelete-page`, `upload-file`, `upload-file-from-url`) from `tools/list`. Result: an anonymous, read-only MCP interface.

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
- **Single wiki only for now.** A bearer is scoped to one MediaWiki OAuth2 realm. Multi-wiki bearer deployment is on the roadmap.
- **Reverse proxy must forward `Authorization` intact** and strip it on untrusted inbound paths. The MCP server trusts any `Authorization: Bearer` header it sees — see [reverse proxy requirements](#reverse-proxy-requirements).
- **Set `MCP_ALLOWED_HOSTS` to the hostname(s) your reverse proxy forwards** (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`). Without it, the SDK's DNS-rebinding check is off and non-matching `Host` headers are not rejected.
- **Set `MCP_ALLOWED_ORIGINS` to the public origin(s) your proxy serves** (e.g. `MCP_ALLOWED_ORIGINS=https://wiki.example.org`). Without it, Origin validation is off and browser requests with a mismatched `Origin` are not rejected.
- **`upload-file` stays off until you opt in.** Configure an allowlist via `uploadDirs` in `config.json` or the `MCP_UPLOAD_DIRS` env var — see [configuration.md — upload directories](configuration.md#upload-directories). With no allowlist, every local-upload attempt is refused.
- **OAuth-spec discovery is available** when a wiki sets `oauth2ClientId`. The server publishes `/.well-known/oauth-protected-resource` and returns `WWW-Authenticate: Bearer realm="MediaWiki MCP Server", resource_metadata="..."` on bearer-less 401s. OAuth-aware MCP clients use this to start the auth-code+PKCE dance against the wiki's authorization server. See [configuration.md — OAuth (browser-based)](configuration.md#oauth-browser-based) for the per-wiki opt-in.

## Shape 3 — Single-wiki, hosted server-mediated OAuth (proxy)

In Shape 2 the caller must obtain a MediaWiki OAuth2 access token themselves and paste it into a header. Shape 3 removes that step: the MCP server acts as an **OAuth 2.1 Authorization Server** toward MCP clients, so an OAuth-aware client signs the user in with no manual token handling.

What it does:

- Serves authorization-server metadata ([RFC 8414](https://www.rfc-editor.org/rfc/rfc8414)) and protected-resource metadata ([RFC 9728](https://www.rfc-editor.org/rfc/rfc9728)), a Dynamic Client Registration endpoint ([RFC 7591](https://www.rfc-editor.org/rfc/rfc7591)) at `/register`, an `/authorize` endpoint with a consent page, a fixed `/oauth/callback`, and a `/token` endpoint that mints the proxy's **own** audience-bound JWT (the bearer the client then sends to `/mcp` is a proxy JWT, not a MediaWiki token).
- Brokers **one** pre-registered MediaWiki Extension:OAuth consumer as a **public + PKCE** client. When a user signs in, the proxy runs the upstream auth-code+PKCE flow against the wiki, stores the resulting MediaWiki token, and hands the client a proxy JWT keyed to it. On each `/mcp` call the server verifies the JWT and resolves it back to the stored MediaWiki token (refreshing it server-to-server when near expiry).

For the user this is **zero-install**: point any OAuth-aware MCP client at `https://<wiki>/mcp` and the client discovers everything, registers itself, and runs the consent flow. Each user authenticates as themselves, so writes are attributable. **Anonymous read is preserved** — a tokenless request is served anonymously; write tools step up to a `401` + `WWW-Authenticate` challenge only when actually invoked (or when a presented bearer is invalid/expired), never up front.

### Required environment

| Name | Description |
|---|---|
| `MCP_PUBLIC_URL` | The proxy's public issuer/base. Set it to the public `/mcp` URL, e.g. `https://wiki.example.org/mcp` — the AS metadata endpoints (`/authorize`, `/token`, `/register`, `/oauth/callback`) are derived from it. |
| `MCP_OAUTH_JWT_SIGNING_KEY` | A secret of **at least 32 characters** used to sign the proxy's issued JWTs and consent cookies. Keep it **fixed** — rotating it invalidates every issued token and forces all users to re-authenticate, so a deploy that changes it logs everyone out. |

The proxy turns on only when **all** of these hold: `MCP_TRANSPORT=http`, `MCP_PUBLIC_URL` and `MCP_OAUTH_JWT_SIGNING_KEY` are set, and the default wiki has an `oauth2ClientId`. A signing key under 32 chars, or a `MCP_OAUTH_TOKEN_TTL` longer than the upstream refresh window, fails startup.

Optional:

| Name | Default | Description |
|---|---|---|
| `MCP_OAUTH_TOKEN_TTL` | `55m` | Lifetime of a proxy-minted access JWT. Must stay **shorter than the upstream 30-day refresh window** — when the JWT expires the client refreshes it, which the proxy backs with a server-to-server upstream refresh. |
| `MCP_OAUTH_CONSENT_TTL` | `30d` | Lifetime of the signed consent cookie. Within this window a returning user (same client + redirect host) skips the consent page; after it they see consent again. |

Both durations accept a number with an optional unit: `s`, `m`, `h`, or `d` (e.g. `55m`, `1h`, `30d`). A bare number is **seconds**.

### Three-base topology

The proxy reads three distinct URLs, which usually differ:

| Base | Source | Role |
|---|---|---|
| Proxy issuer | `MCP_PUBLIC_URL` | The AS identity the client talks to: the host that serves metadata, `/authorize`, `/token`, `/register`, and the fixed `/oauth/callback`. |
| Upstream authorize host | per-wiki `publicServer` (falls back to `server`) | The **browser-facing** wiki URL the user is redirected to for the upstream MediaWiki consent screen (`…/rest.php/oauth2/authorize`). |
| Internal API host | per-wiki `server` | The wiki API used for tool calls **and** the server→wiki token exchange/refresh (`…/rest.php/oauth2/access_token`). |

The split exists because the browser must reach a **public** authorize URL (the user's browser is redirected there and back), while the server's own API traffic and the confidential token exchange should stay on the **internal** address (e.g. a Docker-network alias that bypasses the public reverse proxy). Set `publicServer` to the public wiki URL and `server` to the internal one; when there is no internal/public split, omit `publicServer` and it falls back to `server`.

### Consumer-registration prerequisite (on the wiki)

This is a one-time wiki-side setup, not server config. Register **one** [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) consumer at `Special:OAuthConsumerRegistration/propose/oauth2`:

- **OAuth 2.0**, requesting **specific permissions** (a *full* consumer — not the owner-only "for use only by me" option), including the edit grants your users need.
- **Public client**: leave "This consumer is confidential" unchecked — the proxy uses PKCE, no client secret.
- Grant types: **Authorization code** and **Refresh token**.
- A single **callback URL** = `<MCP_PUBLIC_URL>/oauth/callback` (Extension:OAuth exact-matches the redirect URI). For example, with `MCP_PUBLIC_URL=https://wiki.example.org/mcp` the callback is `https://wiki.example.org/mcp/oauth/callback`.

Put the resulting consumer key in the default wiki's `oauth2ClientId`. Leave the consumer secret unused. See [configuration.md — registering the OAuth consumer](configuration.md#for-wiki-admins-registering-the-oauth-consumer) for the field-by-field walkthrough.

### Proxy routing requirements

In addition to the [general reverse proxy requirements](#reverse-proxy-requirements) below, route the OAuth discovery and AS endpoints to the MCP server:

- The MCP server serves the AS metadata at the **root** well-known paths: `/.well-known/oauth-protected-resource` **and** `/.well-known/oauth-authorization-server` (the SDK also fetches the `…/mcp`-suffixed variant `/.well-known/oauth-authorization-server/mcp`). Route all of these to the MCP server.
- The `/authorize`, `/consent`, `/oauth/callback`, `/register`, and `/token` endpoints all live under the existing `/mcp` path (`/mcp/authorize`, `/mcp/token`, …), so they ride along with the route you already forward to `/mcp`.
- **Forward `Authorization` intact** (see the trust-boundary note in [reverse proxy requirements](#reverse-proxy-requirements)).
- Set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` to the public host/origin (e.g. `MCP_ALLOWED_HOSTS=wiki.example.org`, `MCP_ALLOWED_ORIGINS=https://wiki.example.org`).

### v1 limitations

- **In-memory state.** Registered clients, in-flight authorizations, one-time codes, and stored upstream tokens live in process memory. A restart drops them, so every user must sign in again, and the proxy currently supports a **single instance** (no shared store across replicas). Because `/register` is unauthenticated, the client registry is capped (FIFO, 10,000 entries) so registration spam cannot exhaust memory; once the cap is reached the oldest registrations are evicted and those clients must re-register.
- **Validated client.** Claude Code is the MCP client this flow has been validated against. Other OAuth-aware clients should work via standard discovery + DCR but are not yet exercised.

### Example `config.json`

```json
{
  "allowWikiManagement": false,
  "defaultWiki": "example.org",
  "wikis": {
    "example.org": {
      "sitename": "Example Wiki",
      "server": "http://mediawiki.svc",
      "publicServer": "https://wiki.example.org",
      "articlepath": "/wiki",
      "scriptpath": "/w",
      "oauth2ClientId": "${WIKI_OAUTH_CLIENT_ID}"
    }
  }
}
```

`server` is the internal API host (here a Docker-network alias — list it in `MCP_TRUSTED_HOSTS` so the outbound SSRF guard permits it); `publicServer` is the browser-facing host; `oauth2ClientId` is the consumer key. No `token` / `username` / `password` (the proxy mints per-user tokens), and `readOnly` is left off so writes are available after sign-in. Run it with `MCP_TRANSPORT=http`, `MCP_PUBLIC_URL=https://wiki.example.org/mcp`, and a fixed `MCP_OAUTH_JWT_SIGNING_KEY`.

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

### Outbound SSRF guard

The server makes a few outbound fetches — the anonymous siteinfo probe (which gates extension tools and fills the `extensions` field of `get-site-info`), wiki discovery, and `*-file-from-url` uploads. These are SSRF-guarded: a destination resolving to a private, loopback, or other non-public address is refused. This stops a client-supplied URL from steering the server at internal infrastructure or cloud metadata.

Running deliberately against an internal host trips this guard — the common Docker case, where a wiki's `server` is a network alias such as `http://mediawiki.svc` chosen to bypass a public reverse proxy. The probe is refused, so extension tools silently disappear and `get-site-info` reports no extensions. List the host in `MCP_TRUSTED_HOSTS` to exempt it from the public-IP check. Entries are comma-separated and match exactly — case-folded, no wildcards or suffixes:

- a **bare host** (`mediawiki.svc`) matches any port;
- a **`host:port`** entry matches only that port.

The exemption skips **only** the public-IP check. The host is still DNS-resolved and its addresses are still pinned, and the guard stays on for every other destination. A listed host is trusted for **every** outbound fetch — wiki discovery and `*-file-from-url`, not only the probe — so list only hosts you control; exact matching means a client cannot reach anything beyond that one declared destination.

`MCP_TRUSTED_HOSTS` is the **outbound** counterpart to `MCP_ALLOWED_HOSTS` (the inbound Host-header check) — the two are unrelated despite the similar names.

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

The image sets `MCP_TRANSPORT=http`, `PORT=8080`, and `MCP_BIND=0.0.0.0` — `MCP_BIND` is set so container port forwarding reaches the listener, since `127.0.0.1` (the host-default) is per-netns and unreachable from the bridge network. It runs as a non-root user and exposes `/mcp` for MCP traffic plus `/health` and `/ready` for orchestration probes.

### Build from source

For local hacking or to customize the image:

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

The `GIT_SHA` build arg populates the `org.opencontainers.image.revision` label so `docker inspect` reports which commit the image was built from. Omit it for ad-hoc builds; the label defaults to `unknown`.

## Operations

Observability (structured logs, `/health` / `/ready`, Prometheus metrics) and graceful shutdown live in [operations.md](operations.md).
