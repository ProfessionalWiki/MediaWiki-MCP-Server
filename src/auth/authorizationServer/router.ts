import { randomUUID } from 'node:crypto';
import express, { type Request, type Response, type RequestHandler } from 'express';
import type { ProxyConfig } from './proxyConfig.js';
import type { ProxyStore, ClientRecord } from './proxyStore.js';
import { buildAsMetadata } from './asMetadata.js';
import { handleRegister } from './register.js';
import { isCimdClientId, CimdResolver } from './cimd.js';
import { planAuthorize, planDeny, type AuthorizeQuery, type ConsentClaims } from './authorize.js';
import {
	renderConsentPage,
	renderCancelledPage,
	renderAuthErrorPage,
	buildConsentCookie,
	readConsentCookie,
	buildCsrfCookie,
	readCsrfCookie,
	buildTxnCookie,
	readTxnCookie,
	clearTxnCookie,
} from './consent.js';
import { verifyConsent } from './jwt.js';
import { handleCallback } from './callback.js';
import { handleToken } from './token.js';

// Everything the authorization-server routes need. Resolved once (from config/env)
// by the caller; the routes 404 per-endpoint when the proxy is disabled
// (getProxyConfig() returns null), exactly as before this was its own module.
export interface AuthorizationServerDeps {
	getProxyConfig: () => ProxyConfig | null;
	store: ProxyStore;
	proxyRedirectPolicy: ((uri: string) => boolean) | null;
	cimdResolver: CimdResolver | null;
	defaultWikiKey: string;
	defaultWikiSitename: string;
}

// Persist the proxy transaction id (carried as `state` on the upstream authorize
// URL) in a cookie, so the callback can recover it even when the upstream drops
// `state` on a denial (MediaWiki's Extension:OAuth does).
function setTxnCookie(res: Response, upstreamLocation: string): void {
	const txnId = new URL(upstreamLocation).searchParams.get('state');
	if (txnId) {
		res.append('Set-Cookie', buildTxnCookie(txnId));
	}
}

// Extracts a human-readable reason string from an OAuth error body. The fields
// are statically typed as `unknown` (the body is a Record<string, unknown>), so
// we narrow explicitly to avoid the linter's no-base-to-string rule.
function errorReason(body: Record<string, unknown>, fallback: string): string {
	const v = body.error_description ?? body.error;
	return typeof v === 'string' ? v : fallback;
}

// Reads the subset of query parameters planAuthorize cares about, coercing each
// to a single string (Express may parse repeated/array/nested params, which the
// OAuth params are never expected to be; only the first scalar is honoured).
function readAuthorizeQuery(query: Request['query']): AuthorizeQuery {
	return {
		client_id: firstScalar(query.client_id),
		redirect_uri: firstScalar(query.redirect_uri),
		state: firstScalar(query.state),
		code_challenge: firstScalar(query.code_challenge),
		code_challenge_method: firstScalar(query.code_challenge_method),
		scope: firstScalar(query.scope),
		resource: firstScalar(query.resource),
	};
}

// Re-serialises the AuthorizeQuery so the consent form's POST action carries the
// exact same parameters back to /mcp/consent. Built from the parsed query rather
// than req.originalUrl so it round-trips only the recognised OAuth params.
function serializeAuthorizeQuery(q: AuthorizeQuery): string {
	const sp = new URLSearchParams();
	for (const [k, v] of Object.entries(q)) {
		if (typeof v === 'string') {
			sp.set(k, v);
		}
	}
	return sp.toString();
}

// Parses a request's redirect_uri hostname, returning undefined when it is
// missing or not a valid absolute URL. planAuthorize independently rejects an
// unregistered/missing redirect, so a parse failure here just means "no consent".
function redirectHostOf(redirectUri: string | undefined): string | undefined {
	if (!redirectUri) {
		return undefined;
	}
	try {
		return new URL(redirectUri).hostname;
	} catch {
		return undefined;
	}
}

// Coerces a possibly-array/undefined query param to its first scalar string.
function firstScalar(v: unknown): string | undefined {
	return typeof v === 'string' ? v : undefined;
}

// Renders the styled OAuth error page with the given status and reason. Reused by
// every authorize / consent / callback failure path.
function sendAuthError(res: Response, status: number, reason: string): void {
	res.status(status).type('html').send(renderAuthErrorPage({ reason }));
}

// Mounts the hosted OAuth proxy's authorization-server endpoints (RFC 8414 metadata,
// RFC 7591 registration, and the authorize / consent / callback / token flow) on the
// app. Each endpoint 404s while the proxy is disabled. Kept out of the transport's
// buildApp so the AS surface lives with the rest of src/auth/authorizationServer/.
export function mountAuthorizationServer(
	app: express.Express,
	deps: AuthorizationServerDeps,
): void {
	const {
		getProxyConfig,
		store,
		proxyRedirectPolicy,
		cimdResolver,
		defaultWikiKey,
		defaultWikiSitename,
	} = deps;

	// Shared guard: returns the active proxy config, or sends the empty-body 404 and
	// null when the proxy is disabled. Every AS endpoint exists only while enabled.
	const proxyEnabledOr404 = (res: Response): ProxyConfig | null => {
		const pc = getProxyConfig();
		if (!pc) {
			res.status(404).end();
		}
		return pc;
	};

	// RFC 8414 authorization-server metadata. Served only when the hosted OAuth
	// proxy is enabled, in which case this server names itself as the AS. The
	// `/mcp` suffix variant covers clients that append the resource path segment
	// to the well-known location.
	const asMetadataHandler: RequestHandler = (_req, res) => {
		const pc = proxyEnabledOr404(res);
		if (!pc) return;
		res.json(buildAsMetadata(pc));
	};
	app.get('/.well-known/oauth-authorization-server', asMetadataHandler);
	app.get('/.well-known/oauth-authorization-server/mcp', asMetadataHandler);

	// RFC 7591 Dynamic Client Registration. Served only when the hosted OAuth
	// proxy is enabled. The request body is already parsed by the top-level
	// express.json() middleware. handleRegister validates redirect_uris against
	// the proxy's redirect policy before minting a public (PKCE-only) client.
	app.post('/mcp/register', (req, res) => {
		if (!getProxyConfig() || !proxyRedirectPolicy) {
			res.status(404).end();
			return;
		}
		const result = handleRegister(req.body, store, proxyRedirectPolicy);
		res.status(result.status).json(result.body);
	});

	// Resolve a client_id to a ClientRecord: CIMD (fetch its metadata document) for a
	// URL id, else the DCR store. For CIMD, `clientIdHost` is the verified host to show
	// at consent; `error` is set (with a reason) only when a CIMD resolve fails.
	async function resolveClient(clientId: string | undefined): Promise<{
		client: ClientRecord | undefined;
		clientIdHost?: string;
		error?: string;
	}> {
		if (clientId && cimdResolver && isCimdClientId(clientId)) {
			const r = await cimdResolver.resolve(clientId);
			if (!r.ok) {
				return { client: undefined, error: r.reason };
			}
			return { client: r.client, clientIdHost: new URL(clientId).host };
		}
		return { client: clientId ? store.getClient(clientId) : undefined };
	}

	// GET /mcp/authorize — the proxy authorization endpoint. Validates the client +
	// redirect, gates on the signed consent cookie (bound to clientId + redirectHost
	// + the default wiki key), and either renders the consent page or 302s to the
	// upstream wiki authorize URL.
	app.get('/mcp/authorize', async (req, res) => {
		const pc = proxyEnabledOr404(res);
		if (!pc) return;
		const q = readAuthorizeQuery(req.query);

		let consent: ConsentClaims | undefined;
		const redirectHost = redirectHostOf(q.redirect_uri);
		const cookie = readConsentCookie(req.headers.cookie);
		if (cookie && q.client_id && redirectHost) {
			const ok = await verifyConsent(cookie, {
				clientId: q.client_id,
				redirectHost,
				wiki: defaultWikiKey,
				signingKey: pc.signingKey,
			});
			if (ok) {
				consent = { clientId: q.client_id, redirectHost, wiki: defaultWikiKey };
			}
		}

		const resolved = await resolveClient(q.client_id);
		if (resolved.error) {
			sendAuthError(res, 400, resolved.error);
			return;
		}
		const plan = planAuthorize(q, consent, pc, store, defaultWikiSitename, resolved.client);
		if (plan.kind === 'error') {
			sendAuthError(res, plan.status, errorReason(plan.body, 'invalid request'));
			return;
		}
		if (plan.kind === 'consent') {
			// Anti-CSRF nonce: set as a SameSite=Strict cookie and embedded in the form
			// so the decision POST can prove it came from this page (double-submit).
			const csrfToken = randomUUID();
			res.append('Set-Cookie', buildCsrfCookie(csrfToken));
			res.type('html').send(
				renderConsentPage({
					clientName: plan.clientName,
					wiki: defaultWikiSitename,
					authorizeQuery: serializeAuthorizeQuery(q),
					csrfToken,
					redirectHost: redirectHost ?? '',
					clientIdHost: resolved.clientIdHost,
				}),
			);
			return;
		}
		setTxnCookie(res, plan.location);
		res.redirect(302, plan.location);
	});

	// POST /mcp/consent — records the user's decision from the consent form. The
	// form action carries the original authorize params in the query string; the
	// decision is form-encoded in the body. On approve we set the signed consent
	// cookie and re-run planAuthorize to 302 to the upstream (Set-Cookie + 302 in
	// the one response is correct: the browser stores the cookie and follows the
	// redirect, so the subsequent upstream callback can be matched).
	app.post('/mcp/consent', express.urlencoded({ extended: false }), async (req, res) => {
		const pc = proxyEnabledOr404(res);
		if (!pc) return;
		const q = readAuthorizeQuery(req.query);
		const resolved = await resolveClient(q.client_id);
		if (resolved.error) {
			sendAuthError(res, 400, resolved.error);
			return;
		}
		const client = resolved.client;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- form-encoded body is untyped; decision is read defensively below
		const body = (req.body ?? {}) as Record<string, unknown>;
		const decision = typeof body.decision === 'string' ? body.decision : undefined;

		if (decision !== 'approve') {
			// Bounce a proper OAuth error back to the client when we can trust its
			// redirect_uri; otherwise show a plain page (the client can't be signalled).
			const denial = planDeny(q, pc, store, client);
			if (denial.kind === 'redirect') {
				res.redirect(302, denial.location);
				return;
			}
			res
				.status(200)
				.type('html')
				.send(renderCancelledPage({ clientName: client?.name }));
			return;
		}

		// decision === 'approve' beyond this point. CSRF: the form must echo the
		// SameSite=Strict nonce set on the consent GET. A cross-site auto-submit can
		// neither carry that cookie nor read it (HttpOnly), so it cannot forge consent.
		const csrfCookie = readCsrfCookie(req.headers.cookie);
		const csrfField = typeof body.csrf === 'string' ? body.csrf : undefined;
		if (!csrfCookie || !csrfField || csrfCookie !== csrfField) {
			sendAuthError(res, 400, 'CSRF check failed');
			return;
		}

		const redirectHost = redirectHostOf(q.redirect_uri);
		if (!q.client_id || !redirectHost) {
			sendAuthError(res, 400, 'missing client_id or redirect_uri');
			return;
		}

		res.append(
			'Set-Cookie',
			await buildConsentCookie(pc, {
				clientId: q.client_id,
				redirectHost,
				wiki: defaultWikiKey,
			}),
		);

		const consent: ConsentClaims = { clientId: q.client_id, redirectHost, wiki: defaultWikiKey };
		const plan = planAuthorize(q, consent, pc, store, defaultWikiSitename, client);
		if (plan.kind === 'error') {
			sendAuthError(res, plan.status, errorReason(plan.body, 'invalid request'));
			return;
		}
		if (plan.kind === 'redirect') {
			setTxnCookie(res, plan.location);
			res.redirect(302, plan.location);
			return;
		}
		// planAuthorize returned 'consent' despite a freshly built ConsentClaims —
		// only reachable if the client vanished between validation steps. Treat as a
		// transient error rather than re-prompting (the cookie is already set).
		sendAuthError(res, 400, 'consent could not be applied');
	});

	// GET /mcp/oauth/callback — the upstream wiki's authorization-code redirect back
	// to the proxy. The `state` param is the proxy-minted transaction id. We verify
	// the consent cookie against the transaction's client + redirect host (the same
	// binding authorize set), then hand off to handleCallback, which exchanges the
	// wiki code on the internal tokenExchangeBase, stores the upstream token, mints a
	// one-time downstream client code, and 302s back to the client redirect.
	app.get('/mcp/oauth/callback', async (req, res) => {
		const pc = proxyEnabledOr404(res);
		if (!pc) return;
		const queryError = firstScalar(req.query.error);
		const q = {
			code: firstScalar(req.query.code),
			// Fall back to the txn cookie ONLY on a denial that dropped `state`
			// (MediaWiki does). Never let the cookie supply `state` for the success/code
			// path, so an injected cookie can't drive a code redemption to a stale txn.
			state:
				firstScalar(req.query.state) ??
				(queryError !== undefined ? readTxnCookie(req.headers.cookie) : undefined),
			error: queryError,
			errorDescription: firstScalar(req.query.error_description),
		};
		// The txn cookie is single-use per flow; expire it now that the callback fired.
		res.append('Set-Cookie', clearTxnCookie());

		// Re-verify the consent cookie here, bound to the transaction's own client +
		// redirect host. handleCallback re-looks-up the txn itself; this lookup only
		// supplies the binding fields for verifyConsent (an idempotent read).
		let consentOk = false;
		const txn = q.state ? store.getTransaction(q.state) : undefined;
		const cookie = readConsentCookie(req.headers.cookie);
		if (txn && cookie) {
			consentOk = await verifyConsent(cookie, {
				clientId: txn.clientId,
				redirectHost: new URL(txn.clientRedirectUri).hostname,
				wiki: defaultWikiKey,
				signingKey: pc.signingKey,
			});
		}

		const plan = await handleCallback(q, pc, store, consentOk);
		if (plan.kind === 'error') {
			sendAuthError(res, plan.status, errorReason(plan.body, 'authorization failed'));
			return;
		}
		res.redirect(302, plan.location);
	});

	// POST /mcp/token — the proxy's RFC 6749 token endpoint. Served only when the
	// hosted OAuth proxy is enabled. Bodies are form-encoded (not JSON), so a route-
	// local express.urlencoded parser is used. handleToken handles both the
	// authorization_code grant (verify client PKCE, consume the one-time code, mint
	// proxy JWTs) and the refresh_token grant (verify the proxy refresh JWT, refresh
	// the upstream token server-to-server, re-mint).
	app.post('/mcp/token', express.urlencoded({ extended: false }), async (req, res) => {
		const pc = proxyEnabledOr404(res);
		if (!pc) return;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- form-encoded body is untyped; handleToken reads each field defensively
		const body = (req.body ?? {}) as Record<string, string>;
		const result = await handleToken(body, pc, store);
		res.status(result.status).json(result.body);
	});
}
