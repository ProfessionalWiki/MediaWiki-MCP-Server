import { randomUUID } from 'node:crypto';
import type { ProxyConfig } from './proxyConfig.ts';
import type { ClientRecord, ProxyStore } from './proxyStore.ts';
import { randomVerifier, s256 } from '../pkce.ts';
import { mwOauth2AuthorizeEndpoint } from '../mwOauth2Endpoints.ts';
import { redirectUriMatches } from './redirectPolicy.ts';

export interface AuthorizeQuery {
	client_id?: string;
	redirect_uri?: string;
	response_type?: string;
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
	// Rendered as a page. Only for a request whose client or redirect_uri we could
	// not establish: bouncing an error to an unverified redirect_uri would make the
	// endpoint an open redirector.
	| { kind: 'error'; status: number; body: Record<string, unknown> }
	// Returned to the client as OAuth error parameters, once its redirect_uri is
	// known-registered (RFC 6749 §4.1.2.1). A page here instead leaves the client
	// waiting on a callback that never arrives.
	| { kind: 'error-redirect'; location: string }
	| { kind: 'consent'; clientName: string }
	| { kind: 'redirect'; location: string };

/**
 * Builds an OAuth error response on a redirect_uri already established as
 * registered for this client. `iss` is always included: asMetadata advertises
 * `authorization_response_iss_parameter_supported`, which obliges a client to
 * reject an authorization response that omits it.
 */
function errorRedirectTo(
	redirectUri: string,
	pc: ProxyConfig,
	error: string,
	description: string,
	state: string | undefined,
): string {
	const u = new URL(redirectUri);
	u.searchParams.set('error', error);
	u.searchParams.set('error_description', description);
	if (state) {
		u.searchParams.set('state', state);
	}
	u.searchParams.set('iss', pc.issuer);
	return u.toString();
}

/**
 * Pure planner for the proxy's /authorize endpoint. Validates the downstream
 * client + redirect_uri (byte-exact match against the client's registered list,
 * except an http loopback request may vary its port — RFC 8252 §7.3; never a
 * loose prefix/policy re-check), the optional `resource` indicator,
 * and the PKCE method. When consent is missing/stale it asks the caller to
 * render the consent page; when consent is present it mints a transaction with
 * a SEPARATE upstream PKCE verifier and produces the upstream authorize URL.
 *
 * The transaction binds the downstream client's PKCE challenge + state + scopes
 * to the proxy's own verifier so the /mcp/oauth/callback handler can complete both legs.
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
	client: ClientRecord | undefined,
): AuthorizePlan {
	const err = (d: string): AuthorizePlan => ({
		kind: 'error',
		status: 400,
		body: { error: 'invalid_request', error_description: d },
	});

	if (!client) {
		return err('unknown client_id');
	}
	// Match against the registered redirect URIs — byte-exact, except an http
	// loopback request may vary its port from the registered entry (RFC 8252
	// §7.3; see redirectUriMatches). Never re-validate any more loosely than that
	// (prefix, host allowlist, or the registration-time policy): a registered URI
	// is otherwise trusted verbatim.
	if (!q.redirect_uri || !client.redirectUris.some((u) => redirectUriMatches(q.redirect_uri!, u))) {
		return err('redirect_uri not registered');
	}
	// Captured in straight-line code: the narrowing above is lost inside a closure,
	// since `q.redirect_uri` is a mutable property.
	const redirectUri = q.redirect_uri;
	// Everything below runs on a redirect_uri we have established as registered, so
	// the client learns about the failure through its own callback.
	const errRedirect = (error: string, d: string): AuthorizePlan => ({
		kind: 'error-redirect',
		location: errorRedirectTo(redirectUri, pc, error, d, q.state),
	});

	// `response_type` is REQUIRED by OAuth 2.1 and `code` is the only value this
	// server supports (asMetadata publishes `response_types_supported: ['code']`).
	// A present-but-unsupported value is refused rather than silently answered with
	// a code the client did not ask for. An absent one is still treated as a code
	// request: clients that omit it work today, and rejecting them would newly break
	// a working setup for no security gain.
	if (q.response_type !== undefined && q.response_type !== 'code') {
		return errRedirect('unsupported_response_type', 'only response_type=code is supported');
	}
	// RFC 8707 resource indicator. A spec-compliant client reads `resource` from
	// the protected-resource document (resolvePublicBase, WITH a trailing slash)
	// and echoes it here, while pc.issuer is the RFC 8414 issuer (slash-free).
	// Both forms denote the same resource, so compare with trailing slashes
	// normalized off rather than rejecting the slash-bearing variant.
	const stripSlash = (s: string): string => s.replace(/\/+$/, '');
	if (q.resource && stripSlash(q.resource) !== stripSlash(pc.issuer)) {
		// RFC 8707 §2 defines invalid_target for a resource the server does not
		// serve, which a client can act on by retrying with a corrected value.
		return errRedirect('invalid_target', 'resource does not match this server');
	}
	if (q.code_challenge_method !== 'S256' || !q.code_challenge) {
		return errRedirect('invalid_request', 'S256 code_challenge required');
	}

	const redirectHost = new URL(redirectUri).hostname;
	const consentOk =
		consent && consent.clientId === client.clientId && consent.redirectHost === redirectHost;
	if (!consentOk) {
		return { kind: 'consent', clientName: client.name };
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

	const u = new URL(mwOauth2AuthorizeEndpoint(pc.authorizeBase, pc.scriptpath));
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
 * client, using the same matching rule as planAuthorize. Without a trusted
 * redirect target we cannot safely emit a 302 (open-redirect guard), so the
 * caller falls back to a plain cancelled page. This mirrors handleCallback's
 * upstream-denial branch (RFC 6749 §4.1.2.1) for the consent step, so a client
 * sees a proper `access_denied` rather than hanging on a callback that never comes.
 */
export function planDeny(
	q: AuthorizeQuery,
	pc: ProxyConfig,
	store: ProxyStore,
	client: ClientRecord | undefined,
): { kind: 'redirect'; location: string } | { kind: 'page' } {
	if (
		!client ||
		!q.redirect_uri ||
		!client.redirectUris.some((u) => redirectUriMatches(q.redirect_uri!, u))
	) {
		return { kind: 'page' };
	}
	return {
		kind: 'redirect',
		location: errorRedirectTo(
			q.redirect_uri,
			pc,
			'access_denied',
			'The user denied the authorization request.',
			q.state,
		),
	};
}
