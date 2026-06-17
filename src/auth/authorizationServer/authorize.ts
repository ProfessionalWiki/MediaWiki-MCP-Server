import { randomUUID } from 'node:crypto';
import type { ProxyConfig } from './proxyConfig.js';
import type { ProxyStore } from './proxyStore.js';
import { randomVerifier, s256 } from '../pkce.js';

export interface AuthorizeQuery {
	client_id?: string;
	redirect_uri?: string;
	state?: string;
	code_challenge?: string;
	code_challenge_method?: string;
	scope?: string;
	resource?: string;
}

export interface ConsentClaims {
	clientId: string;
	redirectHost: string;
	wiki: string;
}

export type AuthorizePlan =
	| { kind: 'error'; status: number; body: Record<string, unknown> }
	| { kind: 'consent'; clientName: string; scopes: string[] }
	| { kind: 'redirect'; location: string };

/**
 * Pure planner for the proxy's /authorize endpoint. Validates the downstream
 * client + redirect_uri (exact match against the client's registered list —
 * never a loose prefix/policy re-check), the optional `resource` indicator,
 * and the PKCE method. When consent is missing/stale it asks the caller to
 * render the consent page; when consent is present it mints a transaction with
 * a SEPARATE upstream PKCE verifier and produces the upstream authorize URL.
 *
 * The transaction binds the downstream client's PKCE challenge + state + scopes
 * to the proxy's own verifier so the callback (Task 8) can complete both legs.
 *
 * `_wikiName` is the human-readable sitename, threaded through for symmetry with
 * the Express glue (which uses it for the consent page); the planner itself does
 * not need it because consent is bound cryptographically by the caller.
 */
export function planAuthorize(
	q: AuthorizeQuery,
	consent: ConsentClaims | undefined,
	pc: ProxyConfig,
	store: ProxyStore,
	_wikiName: string,
): AuthorizePlan {
	const err = (d: string): AuthorizePlan => ({
		kind: 'error',
		status: 400,
		body: { error: 'invalid_request', error_description: d },
	});

	const client = q.client_id ? store.getClient(q.client_id) : undefined;
	if (!client) {
		return err('unknown client_id');
	}
	// Exact match against the registered redirect URIs — the whole string,
	// including any query component. Never re-validate loosely (prefix, host
	// allowlist, or the registration-time policy): a registered URI is trusted
	// verbatim and only verbatim.
	if (!q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
		return err('redirect_uri not registered');
	}
	// RFC 8707 resource indicator. A spec-compliant client reads `resource` from
	// the protected-resource document (resolvePublicBase, WITH a trailing slash)
	// and echoes it here, while pc.issuer is the RFC 8414 issuer (slash-free).
	// Both forms denote the same resource, so compare with trailing slashes
	// normalized off rather than rejecting the slash-bearing variant.
	const stripSlash = (s: string): string => s.replace(/\/+$/, '');
	if (q.resource && stripSlash(q.resource) !== stripSlash(pc.issuer)) {
		return err('resource does not match this server');
	}
	if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
		return err('S256 code_challenge required');
	}

	const redirectHost = new URL(q.redirect_uri).hostname;
	const consentOk =
		consent && consent.clientId === client.clientId && consent.redirectHost === redirectHost;
	if (!consentOk) {
		return {
			kind: 'consent',
			clientName: client.name,
			scopes: q.scope?.split(' ').filter(Boolean) ?? client.scopes,
		};
	}

	const txnId = randomUUID();
	const proxyVerifier = randomVerifier();
	store.putTransaction(txnId, {
		clientId: client.clientId,
		clientRedirectUri: q.redirect_uri,
		clientState: q.state ?? '',
		clientCodeChallenge: q.code_challenge,
		clientCodeChallengeMethod: 'S256',
		scopes: [],
		proxyVerifier,
	});

	const u = new URL(`${pc.authorizeBase}${pc.scriptpath}/rest.php/oauth2/authorize`);
	u.searchParams.set('response_type', 'code');
	u.searchParams.set('client_id', pc.upstreamClientId);
	u.searchParams.set('redirect_uri', pc.callbackUrl);
	// Scope-agnostic by design: the proxy always requests the empty scope, which makes
	// MediaWiki grant the consumer's full registered grants (basic/read included). We do
	// NOT forward the client's requested scope — that would let a narrow request drop
	// `basic` (→ readapidenied) and would forward non-grant junk (e.g. a client appending
	// `offline_access`) straight to the wiki. The proxy's own JWT scope claim stays
	// informational, matching the refresh path (token.ts).
	u.searchParams.set('scope', '');
	u.searchParams.set('state', txnId);
	u.searchParams.set('code_challenge', s256(proxyVerifier));
	u.searchParams.set('code_challenge_method', 'S256');
	return { kind: 'redirect', location: u.toString() };
}

/**
 * Pure planner for a denial on the proxy's own consent page ("Deny" on the first
 * screen). Aborts the flow by bouncing an OAuth error back to the downstream
 * client — but ONLY to a redirect_uri we have validated as registered for this
 * client, using the same exact-match rule as planAuthorize. Without a trusted
 * redirect target we cannot safely emit a 302 (open-redirect guard), so the
 * caller falls back to a plain cancelled page. This mirrors handleCallback's
 * upstream-denial branch (RFC 6749 §4.1.2.1) for the consent step, so a client
 * sees a proper `access_denied` rather than hanging on a callback that never comes.
 */
export function planDeny(
	q: AuthorizeQuery,
	pc: ProxyConfig,
	store: ProxyStore,
): { kind: 'redirect'; location: string } | { kind: 'page' } {
	const client = q.client_id ? store.getClient(q.client_id) : undefined;
	if (!client || !q.redirect_uri || !client.redirectUris.includes(q.redirect_uri)) {
		return { kind: 'page' };
	}
	const u = new URL(q.redirect_uri);
	u.searchParams.set('error', 'access_denied');
	u.searchParams.set('error_description', 'The user denied the authorization request.');
	if (q.state) {
		u.searchParams.set('state', q.state);
	}
	u.searchParams.set('iss', pc.issuer);
	return { kind: 'redirect', location: u.toString() };
}
