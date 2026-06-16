import { randomUUID } from 'node:crypto';
import type { ProxyConfig } from './proxyConfig.js';
import type { ProxyStore } from './proxyStore.js';
import { exchangeCode as defaultExchange } from '../oauthFlow.js';

type ExchangeFn = typeof defaultExchange;

export type CallbackPlan =
	| { kind: 'redirect'; location: string }
	| { kind: 'error'; status: number; body: Record<string, unknown> };

/**
 * Pure planner for the proxy's /oauth/callback endpoint — the upstream wiki's
 * authorization-code redirect back to the proxy. Looks up the transaction by
 * `state` (the proxy-minted txn id from planAuthorize), requires the consent
 * cookie to have already been verified by the caller, exchanges the wiki code
 * on the INTERNAL tokenExchangeBase using the txn's own PKCE verifier, stores
 * the resulting upstream token, mints a one-time downstream client code bound to
 * the original client's PKCE challenge/state/scopes, and produces the 302 back
 * to the downstream client's redirect URI.
 *
 * `exchange` is injectable for testing; production passes the real exchangeCode.
 */
export async function handleCallback(
	q: { code?: string; state?: string; error?: string; errorDescription?: string },
	pc: ProxyConfig,
	store: ProxyStore,
	consentOk: boolean,
	exchange: ExchangeFn = defaultExchange,
): Promise<CallbackPlan> {
	const err = (d: string): CallbackPlan => ({
		kind: 'error',
		status: 400,
		body: { error: 'invalid_request', error_description: d },
	});

	// Upstream denial/error (RFC 6749 §4.1.2.1): when the user declines the grant
	// the wiki redirects back with `error` (e.g. access_denied) and no `code`.
	// Propagate it to the downstream client's redirect_uri so the client sees a
	// proper OAuth error, rather than this endpoint reporting a misleading generic
	// "missing code/state". This aborts the flow — it needs no consent and runs
	// before the code/state check.
	if (q.error) {
		const denyTxn = q.state ? store.getTransaction(q.state) : undefined;
		if (!denyTxn) {
			// No transaction to tie the denial to a client redirect — surface it plainly.
			return {
				kind: 'error',
				status: 400,
				body: {
					error: q.error,
					error_description: q.errorDescription ?? 'Authorization was not granted.',
				},
			};
		}
		store.deleteTransaction(q.state!);
		const e = new URL(denyTxn.clientRedirectUri);
		e.searchParams.set('error', q.error);
		if (q.errorDescription) {
			e.searchParams.set('error_description', q.errorDescription);
		}
		if (denyTxn.clientState) {
			e.searchParams.set('state', denyTxn.clientState);
		}
		e.searchParams.set('iss', pc.issuer);
		return { kind: 'redirect', location: e.toString() };
	}

	if (!q.state || !q.code) {
		return err('missing code/state');
	}
	const txn = store.getTransaction(q.state);
	if (!txn) {
		return err('unknown or expired transaction');
	}
	if (!consentOk) {
		return err('consent not present');
	}

	let tokens;
	try {
		// redirectUri must be byte-identical to the one sent on /authorize
		// (pc.callbackUrl) or the upstream rejects the exchange. tokenEndpoint
		// uses tokenExchangeBase (the internal service URL), distinct from the
		// public authorizeBase the browser was redirected to.
		tokens = await exchange({
			tokenEndpoint: `${pc.tokenExchangeBase}${pc.scriptpath}/rest.php/oauth2/access_token`,
			code: q.code,
			redirectUri: pc.callbackUrl,
			clientId: pc.upstreamClientId,
			verifier: txn.proxyVerifier,
		});
	} catch {
		return err('upstream token exchange failed');
	}

	const upstreamTokenId = store.putUpstreamToken({
		accessToken: tokens.access_token,
		refreshToken: tokens.refresh_token,
		expiresAt: Date.now() + tokens.expires_in * 1000,
	});
	const clientCode = randomUUID();
	store.putCode(clientCode, {
		clientId: txn.clientId,
		clientRedirectUri: txn.clientRedirectUri,
		clientCodeChallenge: txn.clientCodeChallenge,
		scopes: txn.scopes,
		upstreamTokenId,
	});
	store.deleteTransaction(q.state);

	const u = new URL(txn.clientRedirectUri);
	u.searchParams.set('code', clientCode);
	if (txn.clientState) {
		u.searchParams.set('state', txn.clientState);
	}
	u.searchParams.set('iss', pc.issuer);
	return { kind: 'redirect', location: u.toString() };
}
