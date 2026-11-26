// src/auth/oauthFlow.ts
import { USER_AGENT } from '../runtime/constants.ts';

const TIMEOUT_MS = 5000;

// Deliberately not the SDK's OAuthTokens, which requires token_type and makes
// expires_in optional — the inverse of what post() enforces. expires_in must
// be present because token stores schedule refresh from it; token_type may be
// absent in MediaWiki responses.
export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope?: string;
	token_type?: string;
}

export type FlowErrorKind =
	| 'invalid_grant'
	| 'invalid_client'
	| 'invalid_token'
	| 'transient'
	| 'malformed';

export class OAuthFlowError extends Error {
	constructor(
		public readonly kind: FlowErrorKind,
		message: string,
	) {
		super(message);
		this.name = 'OAuthFlowError';
	}
}

export type RefreshErrorClass = 'retryable' | 'dead';

// Classifies a refresh-grant failure so every caller reacts consistently. A
// transient or malformed upstream failure (wiki 5xx, connection blip, garbled
// body) is `retryable`: the presented refresh token is still good, so a caller
// should surface a retryable error rather than force a full re-authentication. A
// genuine rejection (invalid_grant/invalid_client) — or any non-OAuth error — is
// `dead`: the refresh token cannot be used again.
export function classifyRefreshError(err: unknown): RefreshErrorClass {
	if (err instanceof OAuthFlowError && (err.kind === 'transient' || err.kind === 'malformed')) {
		return 'retryable';
	}
	return 'dead';
}

export interface ExchangeArgs {
	tokenEndpoint: string;
	code: string;
	verifier: string;
	clientId: string;
	redirectUri: string;
	// Set only when the upstream consumer is confidential. MediaWiki requires a
	// client secret on the refresh grant (a public client can't refresh); sending
	// it here lets the same consumer be used confidentially for both grants.
	clientSecret?: string;
}

export interface RefreshArgs {
	tokenEndpoint: string;
	refreshToken: string;
	clientId: string;
	// See ExchangeArgs.clientSecret. Without it, MediaWiki rejects a public
	// client's refresh with invalid_client.
	clientSecret?: string;
}

// Adds `client_secret` to a token-request body only when the upstream consumer
// is confidential, keeping the public/PKCE default byte-for-byte unchanged.
function withClientSecret(
	body: Record<string, string>,
	clientSecret?: string,
): Record<string, string> {
	return clientSecret ? { ...body, client_secret: clientSecret } : body;
}

export async function exchangeCode(a: ExchangeArgs): Promise<TokenResponse> {
	return post(
		a.tokenEndpoint,
		withClientSecret(
			{
				grant_type: 'authorization_code',
				code: a.code,
				code_verifier: a.verifier,
				client_id: a.clientId,
				redirect_uri: a.redirectUri,
			},
			a.clientSecret,
		),
	);
}

export async function refreshTokens(a: RefreshArgs): Promise<TokenResponse> {
	return post(
		a.tokenEndpoint,
		withClientSecret(
			{
				grant_type: 'refresh_token',
				refresh_token: a.refreshToken,
				client_id: a.clientId,
			},
			a.clientSecret,
		),
	);
}

// The wiki user an access token acts for, as Extension:OAuth's profile endpoint reports it.
export interface WikiProfile {
	sub: string;
}

export async function fetchProfile(endpoint: string, accessToken: string): Promise<WikiProfile> {
	const res = await send('Profile endpoint', endpoint, {
		headers: { Authorization: `Bearer ${accessToken}` },
	});
	if (res.status === 401 || res.status === 403) {
		throw new OAuthFlowError('invalid_token', `Profile endpoint refused the token: ${res.status}`);
	}
	if (!res.ok) {
		throw new OAuthFlowError('transient', `Profile endpoint returned ${res.status}`);
	}
	const obj = await readJson('Profile endpoint', res);
	if (typeof obj.sub !== 'string') {
		throw new OAuthFlowError('malformed', 'Profile response carries no sub');
	}
	// A machine token acts as the anonymous user, central id 0; an account with
	// no central id has an empty one.
	if (obj.sub === '' || obj.sub === '0') {
		throw new OAuthFlowError('invalid_token', 'The token acts for no wiki user');
	}
	return { sub: obj.sub };
}

async function post(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
	const res = await send('Token endpoint', endpoint, {
		method: 'POST',
		headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
		body: new URLSearchParams(body).toString(),
	});

	// 5xx → transient
	if (res.status >= 500) {
		throw new OAuthFlowError('transient', `Token endpoint returned ${res.status}`);
	}

	const obj = await readJson('Token endpoint', res);

	// Any non-2xx below 500: classify by the OAuth error code. MediaWiki returns
	// 401 invalid_client (not 400) when a public client cannot authenticate for
	// the refresh grant, so invalid_client must be recognised regardless of status
	// — otherwise a permanent misconfiguration reads as a retryable transient error.
	if (!res.ok) {
		const code = typeof obj.error === 'string' ? obj.error : '';
		if (code === 'invalid_grant') {
			throw new OAuthFlowError('invalid_grant', 'Token request failed: invalid_grant');
		}
		if (code === 'invalid_client') {
			throw new OAuthFlowError('invalid_client', 'Token request failed: invalid_client');
		}
		throw new OAuthFlowError('transient', `Token request failed: ${code || res.status}`);
	}

	// 200 but missing required fields
	if (typeof obj.access_token !== 'string' || typeof obj.expires_in !== 'number') {
		throw new OAuthFlowError('malformed', 'Token response missing access_token or expires_in');
	}

	return {
		access_token: obj.access_token,
		refresh_token: typeof obj.refresh_token === 'string' ? obj.refresh_token : undefined,
		expires_in: obj.expires_in,
		scope: typeof obj.scope === 'string' ? obj.scope : undefined,
		token_type: typeof obj.token_type === 'string' ? obj.token_type : undefined,
	};
}

interface RequestSpec {
	method?: string;
	headers: Record<string, string>;
	body?: string;
}

// The timeout covers reading the body too, which callers do after this returns.
async function send(label: string, endpoint: string, init: RequestSpec): Promise<Response> {
	try {
		return await fetch(endpoint, {
			...init,
			headers: { ...init.headers, 'User-Agent': USER_AGENT },
			signal: AbortSignal.timeout(TIMEOUT_MS),
		});
	} catch (err: unknown) {
		throw new OAuthFlowError('transient', `${label} request failed: ${String(err)}`);
	}
}

async function readJson(label: string, res: Response): Promise<Record<string, unknown>> {
	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new OAuthFlowError('malformed', `${label} response is not valid JSON`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON boundary; callers validate the fields they read
	return json as Record<string, unknown>;
}
