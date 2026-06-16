// tests/helpers/fakeMcpClient.ts
import type { Express } from 'express';
import request from 'supertest';
import { randomVerifier, s256 } from '../../src/auth/pkce.js';

/**
 * Drives the full hosted-OAuth-proxy authorization-code flow against a REAL
 * buildApp() Express app (via supertest) plus a live fakeAuthorizationServer:
 *
 *   1. DCR            POST  /mcp/register
 *   2. authorize      GET   /mcp/authorize   -> consent page
 *   3. consent        POST  /mcp/consent     -> Set-Cookie + 302 to upstream
 *   4. upstream auth  GET   {fakeAs}/.../authorize (real fetch) -> 302 to callback
 *   5. proxy callback GET   /mcp/oauth/callback (carrying consent cookie)
 *                                            -> 302 back to the client redirect
 *   6. token          POST  /mcp/token       -> proxy access + refresh JWTs
 *
 * Steps 4/5 stand in for the browser: the proxy 302s the (synthetic) browser to
 * the upstream wiki authorize URL; the fake AS auto-approves by redirecting to
 * the proxy's loopback callback URL. Because the proxy app has no real listening
 * socket at its issuer host, we extract the code + state from that redirect and
 * replay it into the proxy's /mcp/oauth/callback route via supertest — exactly
 * what a browser following the Location header would do, minus the network hop.
 *
 * The consent cookie set in step 3 is threaded through steps 2-5 the way a
 * browser would (Cookie header), so the cookie-bound consent checks in
 * /authorize and /oauth/callback pass.
 */

export interface FakeMcpClientOptions {
	app: Express;
	// The downstream client's loopback redirect (RFC 8252). Must pass the proxy's
	// register redirect policy (http loopback or the claude.ai callback).
	redirectUri?: string;
	// The OAuth `state` the client sends on /authorize; echoed back on the final
	// client redirect.
	clientState?: string;
	// The `resource` indicator. Defaults to the `resource` field of the
	// protected-resource document (WITH trailing slash, the spec-correct source);
	// override to drive a mismatch.
	resource?: string;
	scope?: string;
}

export interface FakeMcpClientResult {
	clientId: string;
	registerBody: Record<string, unknown>;
	// The proxy /token response body (access_token, refresh_token, ...).
	tokenBody: Record<string, unknown>;
	accessToken: string;
	refreshToken: string;
	// The one-time downstream authorization code the proxy minted (already
	// redeemed at /token).
	clientCode: string;
	// The downstream redirect_uri used throughout the flow.
	redirectUri: string;
	// The PKCE verifier the client used for the downstream leg.
	codeVerifier: string;
}

export class FakeMcpClientError extends Error {
	public constructor(
		message: string,
		public readonly status: number,
		public readonly body: unknown,
	) {
		super(message);
		this.name = 'FakeMcpClientError';
	}
}

const DEFAULT_REDIRECT = 'http://127.0.0.1:38080/callback';

// Reads the `resource` indicator from the protected-resource document — the
// spec-correct source a compliant client echoes on /authorize. This value
// carries a trailing slash (resolvePublicBase), distinct from the slash-free
// RFC 8414 issuer, so it exercises the trailing-slash normalization on the
// proxy's /authorize resource check.
async function fetchProtectedResource(app: Express): Promise<string> {
	const res = await request(app).get('/.well-known/oauth-protected-resource');
	if (res.status !== 200) {
		throw new FakeMcpClientError('protected-resource doc not available', res.status, res.body);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- metadata body is untyped JSON
	return (res.body as { resource: string }).resource;
}

export async function registerClient(
	app: Express,
	redirectUri: string,
	clientName = 'Fake MCP Client',
): Promise<{ clientId: string; body: Record<string, unknown> }> {
	const res = await request(app)
		.post('/mcp/register')
		.set('Content-Type', 'application/json')
		.send({
			redirect_uris: [redirectUri],
			client_name: clientName,
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			token_endpoint_auth_method: 'none',
		});
	if (res.status !== 201) {
		throw new FakeMcpClientError('DCR failed', res.status, res.body);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- register body is untyped JSON
	const body = res.body as Record<string, unknown>;
	return { clientId: String(body.client_id), body };
}

// Parses the Set-Cookie header(s) for the mcp_consent cookie and returns a value
// suitable for a subsequent Cookie request header.
function consentCookieFrom(setCookie: string[] | undefined): string {
	const headers = setCookie ?? [];
	for (const c of headers) {
		const first = c.split(';')[0];
		if (first.startsWith('mcp_consent=')) {
			return first;
		}
	}
	throw new Error('no mcp_consent cookie was set on the consent response');
}

export async function runHostedFlow(opts: FakeMcpClientOptions): Promise<FakeMcpClientResult> {
	const app = opts.app;
	const redirectUri = opts.redirectUri ?? DEFAULT_REDIRECT;
	const clientState = opts.clientState ?? 'client-state-xyz';
	const scope = opts.scope ?? 'mwoauth-authonly';

	// Default the resource indicator to the protected-resource document's
	// `resource` field (WITH trailing slash) — the spec-correct source a real
	// client echoes — rather than the slash-free AS issuer.
	const resource = opts.resource ?? (await fetchProtectedResource(app));

	// 1. Dynamic Client Registration.
	const { clientId, body: registerBody } = await registerClient(app, redirectUri);

	// Downstream PKCE pair (the client's own; distinct from the proxy's upstream
	// verifier minted inside planAuthorize).
	const codeVerifier = randomVerifier();
	const codeChallenge = s256(codeVerifier);

	const authorizeParams = {
		client_id: clientId,
		redirect_uri: redirectUri,
		state: clientState,
		code_challenge: codeChallenge,
		code_challenge_method: 'S256',
		scope,
		resource,
	};

	// 2. /authorize with no cookie -> consent interstitial (HTML).
	const authRes = await request(app).get('/mcp/authorize').query(authorizeParams);
	if (authRes.status !== 200 || !/Authorize application/.test(authRes.text)) {
		throw new FakeMcpClientError('expected consent page', authRes.status, authRes.text);
	}

	// 3. Approve consent. The form action carries the same authorize params in the
	// query string; the decision is form-encoded. Response: Set-Cookie + 302 to
	// the upstream wiki authorize URL.
	const consentRes = await request(app)
		.post('/mcp/consent')
		.query(authorizeParams)
		.type('form')
		.send({ decision: 'approve' });
	if (consentRes.status !== 302) {
		throw new FakeMcpClientError('consent did not redirect', consentRes.status, consentRes.body);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- supertest header value is string|string[]
	const consentCookie = consentCookieFrom(consentRes.headers['set-cookie'] as string[] | undefined);
	const upstreamAuthorizeUrl = consentRes.headers.location;
	if (typeof upstreamAuthorizeUrl !== 'string') {
		throw new Error('consent response carried no Location');
	}

	// 4. Synthetic browser: hit the upstream (fake AS) authorize URL. The fake AS
	// auto-approves and 302s to the proxy's loopback callback (pc.callbackUrl),
	// carrying ?code=...&state=<txnId>. Follow=false so we read the Location.
	const upstreamRes = await fetch(upstreamAuthorizeUrl, { redirect: 'manual' });
	const callbackLocation = upstreamRes.headers.get('location');
	if (!callbackLocation) {
		throw new Error(
			`fake AS authorize did not redirect (status ${upstreamRes.status}); ` +
				'its /authorize handler must 302 to redirect_uri with code+state',
		);
	}
	const cbUrl = new URL(callbackLocation);
	const code = cbUrl.searchParams.get('code');
	const state = cbUrl.searchParams.get('state');
	if (!code || !state) {
		throw new Error('fake AS callback redirect missing code/state');
	}

	// 5. Replay the upstream callback into the proxy (what the browser following
	// the Location would do). Carry the consent cookie. The proxy exchanges the
	// wiki code server-to-server, stores the upstream token, mints a one-time
	// downstream client code, and 302s back to the client redirect.
	const cbRes = await request(app)
		.get('/mcp/oauth/callback')
		.query({ code, state })
		.set('Cookie', consentCookie);
	if (cbRes.status !== 302) {
		throw new FakeMcpClientError('callback did not redirect', cbRes.status, cbRes.body);
	}
	const clientRedirect = cbRes.headers.location;
	if (typeof clientRedirect !== 'string') {
		throw new Error('callback response carried no Location');
	}
	const clientCb = new URL(clientRedirect);
	const clientCode = clientCb.searchParams.get('code');
	if (!clientCode) {
		throw new Error('client redirect missing authorization code');
	}

	// 6. Redeem the downstream code at the proxy token endpoint with the client's
	// PKCE verifier.
	const tokenRes = await request(app).post('/mcp/token').type('form').send({
		grant_type: 'authorization_code',
		code: clientCode,
		code_verifier: codeVerifier,
		client_id: clientId,
		redirect_uri: redirectUri,
	});
	if (tokenRes.status !== 200) {
		throw new FakeMcpClientError('token exchange failed', tokenRes.status, tokenRes.body);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- token body is untyped JSON
	const tokenBody = tokenRes.body as Record<string, unknown>;

	return {
		clientId,
		registerBody,
		tokenBody,
		accessToken: String(tokenBody.access_token),
		refreshToken: String(tokenBody.refresh_token),
		clientCode,
		redirectUri,
		codeVerifier,
	};
}
