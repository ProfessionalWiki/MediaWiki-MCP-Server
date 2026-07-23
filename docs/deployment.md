# Deployment

> [!WARNING]
> **Experimental: work in progress.** Hosting the server for other people is supported for **one wiki at a time**. Do not expose the server to mutually untrusted users with a shared `config.json` token or bot password. That collapses every caller into one wiki identity, with no audit trail and no per-user rate limits. The sign-in setup below avoids that.

This guide is for administrators running the MediaWiki MCP Server as a **shared HTTP endpoint** that other people (and their AI clients) reach over the network. If you only want the server for yourself, install it locally with the default stdio transport instead; see the [README](../README.md#installation).

Over HTTP, clients connect to the fixed `/mcp` path on your host:

```
https://wiki.example.org/mcp
```

The path is not configurable. Locally the server listens on `http://localhost:3000/mcp`; the Docker image defaults to `http://localhost:8080/mcp`.

## Choose your setup

There are two ways to host the server. Pick the row that matches what you want your users to do.

| If you want… | Users can | You provide |
|---|---|---|
| **A public, read-only endpoint** | Read pages without signing in | A `readOnly` wiki entry + a TLS reverse proxy |
| **Users to read *and* write as themselves** _(recommended)_ | Read, and write as their own account after a browser sign-in | An OAuth consumer on the wiki + a few proxy environment variables |

Both run the HTTP transport (`MCP_TRANSPORT=http`) behind a reverse proxy that terminates TLS, and both finish with the [Security checklist](#security-checklist). The first row serves anonymous reads only; in the second, every write is attributed to the user who made it.

- Public, read-only → [Public read-only endpoint](#public-read-only-endpoint)
- Sign-in with writes → [Hosted OAuth sign-in](#hosted-oauth-sign-in)

## Public read-only endpoint

Serve a single wiki for anonymous reads: no sign-in, no writes. Good for public documentation wikis.

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

`readOnly: true` together with `allowWikiManagement: false` hides the wiki-management tools (`add-wiki`, `remove-wiki`) and the six write tools (`create-page`, `update-page`, `delete-page`, `undelete-page`, `upload-file`, `upload-file-from-url`) from `tools/list`. What remains is an anonymous, read-only interface.

Then run it with `MCP_TRANSPORT=http` behind a reverse proxy that terminates TLS and applies rate limiting (Cloudflare, nginx, and Caddy all work), then set the [Host and Origin allowlists](#security-checklist).

## Hosted OAuth sign-in

This is the recommended way to offer **writes** over HTTP. The server runs a built-in OAuth 2.1 Authorization Server (the **proxy**) in front of one MediaWiki OAuth consumer. An OAuth-aware MCP client points at `https://<wiki>/mcp`, the user signs in through their browser, and the server runs the MediaWiki authorization flow on their behalf. No one ever handles a raw MediaWiki token, and every write is attributed to the user who made it.

For the client this is **zero-install**: it discovers the endpoints, registers itself, and runs the consent flow automatically. (For what happens under the hood, see [How the proxy works](#how-the-proxy-works).)

How sign-in is triggered depends on the wiki:

- **Public wiki:** reads work without signing in; the client is prompted to sign in only when a write needs authentication.
- **Private wiki** (`private: true`): nothing is readable anonymously, so the client is challenged to sign in the moment it connects rather than failing on the first tool call.

Set it up in five steps.

### 1. Register an OAuth consumer on your wiki

One-time, wiki-side setup, with [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) installed. At `Special:OAuthConsumerRegistration/propose/oauth2`, register **one** consumer:

- **OAuth 2.0**, requesting **specific permissions** (a *full* consumer, not the owner-only "for use only by me" option), including the edit grants your users need.
- **Grant types:** Authorization code and Refresh token.
- **Callback URL:** exactly `<MCP_PUBLIC_URL>/oauth/callback`; Extension:OAuth exact-matches the redirect URI. With `MCP_PUBLIC_URL=https://wiki.example.org/mcp`, that is `https://wiki.example.org/mcp/oauth/callback`.
- **Confidential client:** check "This consumer is confidential" and keep the **client secret** it shows. The proxy authenticates with that secret to refresh tokens and keep users signed in past the wiki's ~1-hour access-token lifetime; it refuses to start without one, so a public/PKCE consumer is not supported.

Copy the resulting consumer **key** into the wiki's `oauth2ClientId` and its **secret** into `oauth2ClientSecret` (next step).

### 2. Configure the wiki

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
      "oauth2ClientId": "${WIKI_OAUTH_CLIENT_ID}",
      "oauth2ClientSecret": "${WIKI_OAUTH_CLIENT_SECRET}"
    }
  }
}
```

- `server`: the **internal** API address the server uses for tool calls and the confidential token exchange. In Docker this is often a network alias (here `http://mediawiki.svc`) that bypasses your public proxy; list it in `MCP_TRUSTED_HOSTS` so the [outbound SSRF guard](#outbound-ssrf-guard) permits it.
- `publicServer`: the **browser-facing** wiki URL the user is redirected to for the MediaWiki consent screen. Omit it when your wiki has a single URL (no separate internal address); it then falls back to `server`.
- `oauth2ClientId`: the consumer key from step 1.
- `oauth2ClientSecret`: the consumer secret from step 1. Keep it out of `config.json` with `${MCP_OAUTH2_CLIENT_SECRET}` substitution or the `MCP_OAUTH2_CLIENT_SECRET` env var.

The proxy mints a per-user token for each signed-in user, so no static credentials appear here; leave `readOnly` off so writes are available after sign-in. (Why the two hostnames differ is detailed under [How the proxy works](#how-the-proxy-works).)

### 3. Set the proxy environment

Set both variables below. The proxy turns on once they are set, `MCP_TRANSPORT=http`, and the default wiki has its `oauth2ClientId` and `oauth2ClientSecret` (from step 2).

| Variable | Description |
|---|---|
| `MCP_PUBLIC_URL` | The proxy's public base: your public `/mcp` URL, e.g. `https://wiki.example.org/mcp`. The `/authorize`, `/token`, `/register`, and `/oauth/callback` endpoints are derived from it. |
| `MCP_OAUTH_JWT_SIGNING_KEY` | A secret of **at least 32 characters** that signs the tokens and consent cookies the proxy issues. Keep it **fixed**: changing it invalidates every issued token and signs all users out on the next deploy. |

Optional tuning. Both accept a number with an optional `s`/`m`/`h`/`d` unit (e.g. `55m`, `1h`, `30d`); a bare number is seconds:

| Variable | Default | Description |
|---|---|---|
| `MCP_OAUTH_TOKEN_TTL` | `55m` | Lifetime of a proxy-issued access token. Must stay shorter than the upstream 30-day refresh window; when it expires the client refreshes, and the proxy refreshes the upstream MediaWiki token server-to-server. |
| `MCP_OAUTH_CONSENT_TTL` | `30d` | How long a returning user (same client and redirect host) skips the consent page; after it they see consent again. |

Startup fails if the signing key is under 32 characters, or if `MCP_OAUTH_TOKEN_TTL` is longer than the upstream refresh window.

### 4. Route the OAuth endpoints through your proxy

On top of the [general reverse-proxy requirements](#security-checklist), forward the discovery and authorization-server endpoints to the MCP server:

- **Well-known metadata at the root:** `/.well-known/oauth-protected-resource` and `/.well-known/oauth-authorization-server` (the SDK also fetches the `/mcp`-suffixed `/.well-known/oauth-authorization-server/mcp`). Route all three to the MCP server.
- **Authorization-server endpoints under `/mcp`:** `/authorize`, `/consent`, `/oauth/callback`, `/register`, and `/token` all live under the existing `/mcp` path (`/mcp/authorize`, `/mcp/token`, …). They ride along with the route you already forward to `/mcp`.
- Forward the `Authorization` header intact, and set `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` to your public host and origin; see the [Security checklist](#security-checklist).

### 5. Test it

Point an OAuth-aware MCP client at `https://wiki.example.org/mcp`. The client should discover the endpoints, register itself, and open a browser sign-in; after consent, a write tool acts as your account. (See [Allowing more clients](#allowing-more-clients) for how to admit clients that aren't trusted by default.)

A worked `config.json` for this setup is the one shown in [step 2](#2-configure-the-wiki), with the internal/public hostname split filled in. Run it with `MCP_TRANSPORT=http`, `MCP_PUBLIC_URL=https://wiki.example.org/mcp`, and a fixed `MCP_OAUTH_JWT_SIGNING_KEY`, and list `mediawiki.svc` in `MCP_TRUSTED_HOSTS`.

### Allowing more clients

If a client can't sign in, add its OAuth callback URL to `MCP_OAUTH_ALLOWED_REDIRECTS` (comma-separated). A client's callback URL comes from its own documentation or its connector setup screen. For a client that uses a different callback per connection, match the whole prefix with a trailing `/*`, for example `https://example.com/mcp/oauth/*`. Changes take effect when you restart the server.

Only add callbacks you recognise as the client's official ones — a redirect you allow is a URL the sign-in can hand the user's authorisation to.

Some clients identify themselves by a vendor-hosted URL instead of a callback; verified first-party ones are trusted out of the box. To admit another client that works this way, add its host to `MCP_OAUTH_CIMD_ALLOWED_HOSTS` (comma-separated bare hosts or `host:port`) rather than `MCP_OAUTH_ALLOWED_REDIRECTS`.

## Running it with Docker

The image is published at `ghcr.io/professionalwiki/mediawiki-mcp-server`. Pull and run it:

```bash
docker pull ghcr.io/professionalwiki/mediawiki-mcp-server:latest
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" \
  ghcr.io/professionalwiki/mediawiki-mcp-server:latest
```

The image sets `MCP_TRANSPORT=http`, `PORT=8080`, and `MCP_BIND=0.0.0.0`. `MCP_BIND` is set so container port forwarding reaches the listener, since `127.0.0.1` (the host-default) is per-netns and unreachable from the bridge network. It runs as a non-root user and exposes `/mcp` for MCP traffic plus `/health` and `/ready` for orchestration probes.

For a public deployment, set both the Host-header and Origin allowlists (see the [Security checklist](#security-checklist)):

```bash
docker run --rm -p 8080:8080 \
  -e MCP_ALLOWED_HOSTS=wiki.example.org \
  -e MCP_ALLOWED_ORIGINS=https://wiki.example.org \
  -v "$(pwd)/config.json:/app/config.json:ro" \
  ghcr.io/professionalwiki/mediawiki-mcp-server:latest
```

### Tag conventions

Each release publishes the following tags (examples shown for `0.8.0`; substitute the release you want):

| Tag | Tracks | Use for |
|---|---|---|
| `0.8.0` | A specific patch release | **Production**; reproducible builds |
| `0.8` | Latest patch in `0.8` | Auto-pickup of patch releases |
| `0` | Latest release in `0.x` | Auto-pickup until the next major |
| `latest` | Most recent stable release | Trying it out, dev environments |
| `edge` | Tip of `master` | Tracking unreleased changes; no stability promise |
| `@sha256:<digest>` | Immutable digest | Strongest immutability guarantee |

### Verify the image signature

Release builds (anything with a semver tag) are signed via [cosign](https://github.com/sigstore/cosign) keyless signing using GitHub's OIDC identity. Verify before deploying:

```bash
cosign verify ghcr.io/professionalwiki/mediawiki-mcp-server@<digest> \
  --certificate-identity-regexp 'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/.github/workflows/publish-image.yml@.*' \
  --certificate-oidc-issuer https://token.actions.githubusercontent.com
```

Edge images are not cosign-signed but still carry SBOM and SLSA provenance attestations. Verify them with `cosign verify-attestation` or `gh attestation verify`.

### Build from source

For local hacking or to customize the image:

```bash
docker build --build-arg GIT_SHA=$(git rev-parse HEAD) -t mediawiki-mcp-server .
docker run --rm -p 8080:8080 -v "$(pwd)/config.json:/app/config.json:ro" mediawiki-mcp-server
```

The `GIT_SHA` build arg populates the image's `org.opencontainers.image.revision` label; omit it for ad-hoc builds.

## Security checklist

Defaults are safe for a localhost bind. Before exposing the HTTP transport to others, confirm all of these:

- **Terminate TLS at a reverse proxy; never expose the port directly.** The server trusts any `Authorization: Bearer` header it receives without origin checks, so authentication is the proxy's job. Run it behind Caddy, nginx, or Traefik, or bind it to `127.0.0.1`; never put the raw HTTP port on an untrusted network.
- **Forward the `Authorization` header intact.** Proxy configs that strip or consume it (`header_up -Authorization`, `proxy_set_header Authorization ""`, a proxy-level basic-auth handler on the MCP route) leave the server with no token, falling back to config or anonymous. On any untrusted inbound path, strip the client-supplied `Authorization` instead, so a caller cannot inject a bearer the server would trust.
- **Set `MCP_ALLOWED_HOSTS`** to the hostnames your proxy forwards (e.g. `wiki.example.org`). This engages the SDK's DNS-rebinding check; requests to `/mcp` with a non-matching `Host` get a 403. Unset on a public bind turns the check off (with a startup warning); unset on a localhost bind is safe.
- **Set `MCP_ALLOWED_ORIGINS`** to the browser origins allowed to call `/mcp` (e.g. `https://wiki.example.org`). A present-but-unlisted `Origin` gets a 403. The match is exact; see [Host and Origin matching](#host-and-origin-matching) for the five ways a value silently rejects every request. Unset on a public bind turns Origin validation off (with a startup warning).
- **List internal destinations in `MCP_TRUSTED_HOSTS`.** Outbound fetches are SSRF-guarded, so a wiki `server` on a private or Docker-internal address (e.g. `mediawiki.svc`) is refused until you exempt it; otherwise extension tools silently disappear. See [outbound SSRF guard](#outbound-ssrf-guard).
- **Keep static credentials out of `config.json`.** The HTTP transport refuses to start when any wiki sets `token`, or both `username` and `password`. Those would become a shared fallback identity for unauthenticated callers, defeating per-user attribution. Set `MCP_ALLOW_STATIC_FALLBACK=true` to opt into a shared-identity deployment; the server then starts with a warning naming the affected wikis.
- **Treat the server as a secret-handling component.** It sees every caller's token in flight. Avoid verbose error logging, and do not pipe raw error objects into error-tracking services that capture arbitrary fields.
- **Leave uploads off until you need them.** `upload-file` stays disabled until you allowlist directories via `uploadDirs` or `MCP_UPLOAD_DIRS`; see [configuration.md: upload directories](configuration.md#upload-directories).

Both allowlists apply only to `/mcp`; `/health` and `/ready` stay reachable so container healthchecks and liveness probes keep working regardless of what you put in them.

## Reference

Background detail for the setups above. Read it when you want the full picture or are debugging a deployment.

### Environment variables

These apply once you self-host the HTTP transport. The core variables common to every setup (`CONFIG`, `MCP_TRANSPORT`, `MCP_LOG_LEVEL`, the result-size caps, and local OAuth) are in the [README environment-variable table](../README.md#environment-variables); config-file substitution and upload-directory variables (`MCP_UPLOAD_DIRS`) are in [configuration.md](configuration.md).

#### HTTP transport

Set `MCP_TRANSPORT=http` to select this transport (the Docker image defaults to it); see the [README core table](../README.md#environment-variables).

| Name | Default | Description |
|---|---|---|
| `PORT` | `3000` (Docker: `8080`) | Listen port. |
| `MCP_BIND` | `127.0.0.1` (Docker: `0.0.0.0`) | Listen interface. Set to `0.0.0.0` outside Docker only when you need remote access. |
| `MCP_MAX_REQUEST_BODY` | `1mb` | HTTP request body cap. Accepts size strings (`b`, `kb`, `mb`, `gb`). |
| `MCP_SESSION_IDLE_TIMEOUT` | `1800` | Seconds an HTTP session may sit idle before it is closed and removed. Any request resets the timer. `0` disables expiry. |
| `MCP_SHUTDOWN_GRACE_MS` | `10000` | Drain timeout in ms on `SIGTERM` / `SIGINT`. See [Graceful shutdown](operations.md#graceful-shutdown). |
| `MCP_METRICS` | unset | Set to `true` to expose Prometheus metrics at `GET /metrics`. See [Metrics](operations.md#metrics). |
| `MCP_ALLOWED_HOSTS` | auto on localhost | Comma-separated Host-header allowlist. See [Security checklist](#security-checklist). |
| `MCP_ALLOWED_ORIGINS` | auto on localhost | Comma-separated `Origin`-header allowlist. See [Security checklist](#security-checklist). |
| `MCP_TRUSTED_HOSTS` | unset | Comma-separated **outbound** SSRF-guard exemptions for internal destinations (e.g. `mediawiki.svc`). See [Outbound SSRF guard](#outbound-ssrf-guard). |
| `MCP_ALLOW_STATIC_FALLBACK` | unset | Allow HTTP startup when a wiki has static credentials, making them a shared fallback identity. See [Security checklist](#security-checklist). |

`MCP_MAX_REQUEST_BODY` matches nginx's `client_max_body_size 1m`. Raise it if `update-page` calls return 413 on legitimately large edits or your wiki has raised `$wgMaxArticleSize` (MediaWiki default 2 MB). Lower it for a tighter DoS guard.

#### Hosted OAuth proxy

| Name | Default | Description |
|---|---|---|
| `MCP_PUBLIC_URL` | unset | The proxy's public issuer/base, e.g. `https://wiki.example.org/mcp`. Enables the hosted OAuth proxy when set alongside `MCP_OAUTH_JWT_SIGNING_KEY` and a default wiki with `oauth2ClientId`. See [Hosted OAuth sign-in](#hosted-oauth-sign-in). |
| `MCP_OAUTH_JWT_SIGNING_KEY` | unset | Secret (≥32 chars) the proxy signs its issued access/refresh JWTs and consent cookies with. Required for the proxy. Keep it **fixed** so tokens survive a restart. See [Hosted OAuth sign-in](#hosted-oauth-sign-in). |
| `MCP_OAUTH_TOKEN_TTL` | `55m` | Lifetime of a proxy-minted access JWT. Must be shorter than the upstream 30-day refresh window. Duration grammar (`55m`/`1h`/`30d`, or bare seconds). |
| `MCP_OAUTH_CONSENT_TTL` | `30d` | Lifetime of the signed consent cookie that lets a returning user skip the consent page. Same duration grammar. |
| `MCP_OAUTH_PROXY_STORE_FILE` | `proxy-store.enc` under the config dir | File where the proxy persists sign-in state across restarts (encrypted with a key derived from `MCP_OAUTH_JWT_SIGNING_KEY`). In Docker it defaults to `/app/data/proxy-store.enc` on a declared volume — mount it, or a restart signs everyone out. See [Proxy state persistence](#proxy-state-persistence). |
| `MCP_OAUTH_ALLOWED_REDIRECTS` | unset | Additional OAuth redirect URIs the proxy accepts at client registration: comma-separated exact URIs and `https://…/*` prefix patterns. Loopback, claude.ai, and verified first-party clients are always allowed. See [Allowing more clients](#allowing-more-clients). |
| `MCP_OAUTH_CIMD_ALLOWED_HOSTS` | unset | Extra hosts to trust for clients that identify by a vendor-hosted URL (Client ID Metadata Documents): comma-separated bare hosts or `host:port`. The first-party clients are always trusted. See [Allowing more clients](#allowing-more-clients). |

### How the proxy works

When enabled, the [hosted OAuth sign-in](#hosted-oauth-sign-in) setup makes this server the OAuth authorization server the MCP client talks to, through the endpoints routed in [step 4](#4-route-the-oauth-endpoints-through-your-proxy). The bearer a client sends to `/mcp` is a token the proxy minted, not a MediaWiki token. The user's MediaWiki token stays server-side, keyed to that bearer, and is refreshed server-to-server through the confidential consumer — this is what keeps users signed in past the wiki's ~1-hour access-token lifetime, and it is the state the [store file](#proxy-state-persistence) persists.

How the sign-in challenge is issued depends on the wiki. On a **public wiki**, a tokenless request is served anonymously; a write that needs authentication returns an authentication error, and an invalid or expired bearer gets a `401` + `WWW-Authenticate` challenge. A **private wiki** (`private: true`, MediaWiki's `$wgGroupPermissions['*']['read'] = false`) answers every request, including the initial connection, with that challenge, so a client prompts for sign-in at connect. The connection-time challenge requires the wiki's `oauth2ClientId`; without it, the `401` advertises an authorization server the wiki does not have, and the server logs a warning at startup.

#### Three-base topology

The proxy reads three distinct URLs, which usually differ:

| Base | Source | Role |
|---|---|---|
| Proxy issuer | `MCP_PUBLIC_URL` | The AS identity the client talks to: the host that serves metadata, `/authorize`, `/token`, `/register`, and the fixed `/oauth/callback`. |
| Upstream authorize host | per-wiki `publicServer` (falls back to `server`) | The **browser-facing** wiki URL the user is redirected to for the upstream MediaWiki consent screen (`…/rest.php/oauth2/authorize`). |
| Internal API host | per-wiki `server` | The wiki API used for tool calls **and** the server→wiki token exchange/refresh (`…/rest.php/oauth2/access_token`). |

The split exists because the browser must reach a **public** authorize URL (the user's browser is redirected there and back), while the server's own API traffic and the confidential token exchange should stay on the **internal** address (e.g. a Docker-network alias that bypasses the public reverse proxy).

### Outbound SSRF guard

The server makes a few outbound fetches: the anonymous siteinfo probe (which gates extension tools and fills the `extensions` field of `get-site-info`), wiki discovery, and `*-file-from-url` uploads. These are SSRF-guarded: a destination resolving to a private, loopback, or other non-public address is refused. This stops a client-supplied URL from steering the server at internal infrastructure or cloud metadata.

Running deliberately against an internal host trips this guard. The common case is Docker, where a wiki's `server` is a network alias such as `http://mediawiki.svc` chosen to bypass a public reverse proxy. The probe is refused, so extension tools silently disappear and `get-site-info` reports no extensions. List the host in `MCP_TRUSTED_HOSTS` to exempt it from the public-IP check. Entries are comma-separated and match exactly (case-folded, no wildcards or suffixes):

- a **bare host** (`mediawiki.svc`) matches any port;
- a **`host:port`** entry matches only that port.

The exemption skips **only** the public-IP check; the host is still DNS-resolved, its addresses are still pinned, and the guard stays on for every other destination. A listed host is trusted for **every** outbound fetch (wiki discovery and `*-file-from-url`, not only the probe), so list only hosts you control; exact matching means a client cannot reach anything beyond that one declared destination.

`MCP_TRUSTED_HOSTS` is the **outbound** counterpart to `MCP_ALLOWED_HOSTS` (the inbound Host-header check); the two are unrelated despite the similar names.

### Host and Origin matching

The `MCP_ALLOWED_HOSTS` and `MCP_ALLOWED_ORIGINS` allowlists from the [Security checklist](#security-checklist) are matched precisely, and the edge cases bite quietly.

**Host header.** On a localhost bind, leaving `MCP_ALLOWED_HOSTS` unset is safe: the SDK auto-allows `localhost`, `127.0.0.1`, and `[::1]`. On a public bind, leaving it unset turns the DNS-rebinding check off and the SDK logs a warning at startup.

**Origin header.** An origin is the scheme, host, and (only if non-default) port, for example `https://wiki.example.org`. On a localhost bind, the default allowlist is the three loopback origins on the bound port (`http://localhost:<port>`, `http://127.0.0.1:<port>`, `http://[::1]:<port>`) so browser clients running alongside the server keep working. A non-localhost bind with no allowlist turns Origin validation off, and the server logs a startup warning.

Matching is exact string equality against what the browser sends. These values all silently 403 every browser request:

- bare hostname (`wiki.example.org`): missing scheme
- trailing slash (`https://wiki.example.org/`): browsers do not include it
- path (`https://wiki.example.org/mcp`): browsers do not include it
- explicit default port (`https://wiki.example.org:443`): browsers drop default ports when serializing
- uppercase scheme (`HTTPS://...`): browsers lowercase it

When in doubt, open your deployed site in a browser and log `window.location.origin`, then copy that value verbatim.

### v1 limitations

These apply to the [hosted OAuth sign-in](#hosted-oauth-sign-in) setup:

- **Single instance only.** Run exactly one proxy process. All of its sign-in state — registered clients, stored MediaWiki tokens, and the in-flight sign-in handshakes (authorization transactions, one-time codes, and refresh-rotation guards) — is held in that process's memory and mirrored to a single local file (see [Proxy state persistence](#proxy-state-persistence)). Horizontal scaling and zero-downtime rolling deploys are not yet supported. Supporting more than one instance would need **both** a shared store for that state (replacing the per-process file) **and** session affinity, so every request from a client — including the two browser legs of a single sign-in — reaches the same instance.

> [!WARNING]
> Do not run more than one instance against a shared store file. There is no runtime guard against a mis-scaled deployment: each process keeps its own in-memory copy of the sign-in state and rewrites the entire encrypted file on every change, so the instances overwrite one another silently — sign-ins and client registrations are lost with no error logged.

### Proxy state persistence

The proxy persists its sign-in state to a local file so a restart or deploy does not sign users out. Set the path with `MCP_OAUTH_PROXY_STORE_FILE` (default: `proxy-store.enc` under the config directory, or `/app/data/proxy-store.enc` in the Docker image). The file is encrypted at rest with a key derived from `MCP_OAUTH_JWT_SIGNING_KEY`.

**In Docker, mount a persistent volume at the store path.** The image declares one at `/app/data`, but you must mount a named volume or a writable host path there, or a container restart wipes it. A host-path bind mount must be writable by the container's non-root user; a named volume handles that automatically.

### Per-request bearer token (HTTP transport)

For **programmatic or non-interactive clients that already hold a MediaWiki OAuth2 access token** (a script, a CI job, an automation backend), the HTTP transport also accepts the token directly, with no browser flow. Most deployments serving humans should use [Hosted OAuth sign-in](#hosted-oauth-sign-in) instead; this is the lower-level primitive it is built on.

The server accepts a standard OAuth 2.1 `Authorization: Bearer` header on each request, as described in the [MCP authorization specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/authorization):

```
Authorization: Bearer <oauth2-access-token>
```

Use a MediaWiki OAuth2 access token obtained from `Special:OAuthConsumerRegistration/propose/oauth2` on the target wiki, with [Extension:OAuth](https://www.mediawiki.org/wiki/Extension:OAuth) installed. The server forwards it to MediaWiki as that caller's token, so writes are attributable and MediaWiki's per-user rate limits apply. A bearer is scoped to a single MediaWiki OAuth2 realm, so this is single-wiki only for now.

When the target wiki sets `oauth2ClientId`, the server also advertises OAuth discovery on this path, so a capable client can run the authorization-code flow against the wiki's **own** authorization server and fetch that token itself instead of you pasting one in. See [configuration.md: OAuth (browser-based)](configuration.md#oauth-browser-based) for the per-wiki opt-in.

**Precedence:** request header → `config.json` `token` → `config.json` `username`/`password` → anonymous. The HTTP transport refuses to start with static credentials in `config.json` unless `MCP_ALLOW_STATIC_FALLBACK=true` is set; see [the Security checklist](#security-checklist) for why.

Each request builds an independent MediaWiki session using the supplied token. Token rotation and revocation take effect on the next MCP session started with the new token.

Example with Claude Code:

```sh
claude mcp add --transport http my-wiki https://wiki.example.org/mcp \
  --header "Authorization: Bearer eyJhbGciOi..."
```

## Operations

Observability (structured logs, `/health` / `/ready`, Prometheus metrics) and graceful shutdown live in [operations.md](operations.md).
