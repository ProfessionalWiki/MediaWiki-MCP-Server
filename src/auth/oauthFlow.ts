// src/auth/oauthFlow.ts

const TIMEOUT_MS = 5000;

export interface TokenResponse {
	access_token: string;
	refresh_token?: string;
	expires_in: number;
	scope?: string;
	token_type?: string;
}

export type FlowErrorKind = 'invalid_grant' | 'invalid_client' | 'transient' | 'malformed';

export class OAuthFlowError extends Error {
	constructor(
		public readonly kind: FlowErrorKind,
		message: string,
	) {
		super(message);
		this.name = 'OAuthFlowError';
	}
}

export interface ExchangeArgs {
	tokenEndpoint: string;
	code: string;
	verifier: string;
	clientId: string;
	redirectUri: string;
}

export interface RefreshArgs {
	tokenEndpoint: string;
	refreshToken: string;
	clientId: string;
}

export async function exchangeCode(a: ExchangeArgs): Promise<TokenResponse> {
	return post(a.tokenEndpoint, {
		grant_type: 'authorization_code',
		code: a.code,
		code_verifier: a.verifier,
		client_id: a.clientId,
		redirect_uri: a.redirectUri,
	});
}

export async function refreshTokens(a: RefreshArgs): Promise<TokenResponse> {
	return post(a.tokenEndpoint, {
		grant_type: 'refresh_token',
		refresh_token: a.refreshToken,
		client_id: a.clientId,
	});
}

async function post(endpoint: string, body: Record<string, string>): Promise<TokenResponse> {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);

	let res: Response;
	try {
		res = await fetch(endpoint, {
			method: 'POST',
			headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
			body: new URLSearchParams(body).toString(),
			signal: ctrl.signal,
		});
	} catch (err: unknown) {
		throw new OAuthFlowError('transient', `Token endpoint request failed: ${String(err)}`);
	} finally {
		clearTimeout(timer);
	}

	// 5xx → transient
	if (res.status >= 500) {
		throw new OAuthFlowError('transient', `Token endpoint returned ${res.status}`);
	}

	let json: unknown;
	try {
		json = await res.json();
	} catch {
		throw new OAuthFlowError('malformed', 'Token endpoint response is not valid JSON');
	}

	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON boundary; fields validated immediately below
	const obj = json as Record<string, unknown>;

	// 400 error responses
	if (res.status === 400) {
		const code = typeof obj.error === 'string' ? obj.error : '';
		if (code === 'invalid_grant') {
			throw new OAuthFlowError('invalid_grant', 'Token request failed: invalid_grant');
		}
		if (code === 'invalid_client') {
			throw new OAuthFlowError('invalid_client', 'Token request failed: invalid_client');
		}
		throw new OAuthFlowError('transient', `Token request failed: ${code}`);
	}

	// Other non-2xx
	if (!res.ok) {
		throw new OAuthFlowError('transient', `Token endpoint returned ${res.status}`);
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
