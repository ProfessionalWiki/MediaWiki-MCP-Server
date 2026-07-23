# src/auth

OAuth for MediaWiki, in two roles. The split between them is the thing to hold in your head:

- **`src/auth/` (top level)** — this server acting as an OAuth **client** to a wiki: discover the wiki's authorization server, run a login flow, acquire and refresh a token, and store it.
- **`src/auth/authorizationServer/`** — this server acting as an OAuth **authorization server** itself: the hosted proxy that fronts a wiki, mints its own per-user tokens, and speaks the full authorize / consent / callback / token / registration surface to downstream MCP clients.

Which role is active depends on configuration. The proxy path turns on only when `resolveProxyConfig` returns a config (HTTP transport + public URL + signing key + a confidential upstream consumer); otherwise the server uses the client path or plain bearer pass-through. Discovery (`metadata.ts`) and the protected-resource metadata are shared: both roles need to know a wiki's authorization server.

## Client side (top level)

- `metadata.ts` — discover an upstream wiki's AS metadata (`.well-known`, pathed, or synthesized). `UpstreamAsMetadata` is the wiki's metadata — not to be confused with the proxy's own `AsMetadataDoc`.
- `mwOauth2Endpoints.ts` — build a wiki's `rest.php/oauth2/{authorize,access_token}` URLs. Single source of truth for those paths, shared with the proxy side.
- `oauthFlow.ts` — the low-level token exchange and refresh HTTP calls, plus the error classifier (`invalid_grant` / `invalid_client` / transient / malformed).
- `acquireToken.ts` — orchestrate acquiring a token for a wiki (discovery → browser login → store).
- `browserAuth.ts` — the interactive login: open the browser, catch the redirect on a loopback listener.
- `tokenRefresh.ts` — refresh a stored token when it is near expiry, with per-wiki dedup.
- `tokenStore.ts` — persist and read back acquired tokens on disk.
- `protectedResource.ts` — build the protected-resource metadata this server advertises to MCP clients.
- `pkce.ts` — PKCE verifier / challenge helpers (used by both roles).
- `paths.ts` — resolve the on-disk config-dir file paths: the client credentials file and the proxy's durable store.

## Authorization server side (`authorizationServer/`, the hosted proxy)

- `proxyConfig.ts` — resolve the proxy config from a wiki plus environment. `ProxyWikiInput` is the wiki slice it needs (distinct from the client-side `WikiSlice`).
- `router.ts` — `mountAuthorizationServer` mounts every AS route on the Express app.
- `asMetadata.ts` — build the RFC 8414 metadata document advertising this server as the authorization server (`AsMetadataDoc`).
- `register.ts` — dynamic client registration.
- `authorize.ts` — plan the `/authorize` step: validate the downstream client and redirect, then produce the upstream authorize URL.
- `consent.ts` — the consent / cancelled / error pages, plus the CSRF, transaction, and consent cookie plumbing (the consent cookie is signed and verified in `jwt.ts`).
- `callback.ts` — handle the upstream wiki's callback, exchange the code, mint a downstream client code.
- `token.ts` — the `/token` endpoint: authorization-code and refresh grants.
- `jwt.ts` — mint and verify the proxy's own access / refresh JWTs, and sign / verify the consent cookie.
- `cimd.ts` — client-id metadata documents: resolve a URL `client_id` into a client record, host-gated.
- `redirectPolicy.ts` — redirect-URI matching and the registration-time redirect-URI allowlist (the CIMD *host* allowlist lives in `cimd.ts`).
- `proxyStore.ts` — the in-memory store (clients, transactions, codes, upstream tokens).
- `proxyStoreCrypto.ts` — encrypt and decrypt the persisted store.
- `proxyStorePersistence.ts` — mirror the store to an encrypted file with write-through.

## Shared

`pageShell.ts` renders the HTML shell used by both roles' user-facing pages — the proxy's consent / status pages and the stdio loopback login pages. Request-scoped state (`runtime/requestContext.ts`) and the auth-shape classifier (`runtime/authShape.ts`) live under `runtime/`, not here, because the transport layer uses them too.
