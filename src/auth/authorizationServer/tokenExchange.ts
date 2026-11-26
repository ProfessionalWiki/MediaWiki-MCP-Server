import { createHash } from 'node:crypto';
import { decodeJwt } from 'jose';
import type { ProxyConfig } from './proxyConfig.ts';
import type { ProxyStore, UpstreamToken } from './proxyStore.ts';
import type { TokenResult } from './token.ts';
import { authenticateExchangeClient, type ExchangeClient } from './exchangeClient.ts';
import { isThisResource } from './authorize.ts';
import { mintAccessToken } from './jwt.ts';
import { mwOauth2ProfileEndpoint } from '../mwOauth2Endpoints.ts';
import { OAuthFlowError, type fetchProfile, type WikiProfile } from '../oauthFlow.ts';

export const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';

export type FetchProfile = typeof fetchProfile;

interface SubjectToken {
	token: string;
	consumer: string;
	grants: string[];
	expiresAt: number;
}

/**
 * The RFC 8693 token-exchange grant: `client` hands over a wiki access token it
 * holds for a user, and gets a proxy access token acting as that user. The wiki
 * confirms the token and names the user. Each user keeps one stored token per
 * consumer and grant set: the one that expires last, so no token already issued
 * outlives it.
 */
export async function handleTokenExchange(
	body: Record<string, unknown>,
	pc: ProxyConfig,
	client: ExchangeClient,
	store: ProxyStore,
	fetchProfile: FetchProfile,
): Promise<TokenResult> {
	if (!(await authenticateExchangeClient(body, client, pc.issuer, store))) {
		return {
			status: 401,
			body: { error: 'invalid_client', error_description: 'client authentication failed' },
		};
	}

	const refusal = refuseRequest(body, pc);
	if (refusal) {
		return refusal;
	}

	const subjectToken = readSubjectToken(body.subject_token);
	if (!subjectToken) {
		return bad('invalid_request', 'subject_token must be a wiki OAuth 2 access token');
	}
	if (!client.consumers.includes(subjectToken.consumer)) {
		return bad(
			'invalid_request',
			'subject_token was issued to a consumer this client may not exchange',
		);
	}

	let profile: WikiProfile;
	try {
		profile = await fetchProfile(
			mwOauth2ProfileEndpoint(pc.internalBase, pc.scriptpath),
			subjectToken.token,
		);
	} catch (err) {
		if (err instanceof OAuthFlowError && err.kind === 'invalid_token') {
			return bad('invalid_request', "the wiki does not accept subject_token as a user's token");
		}
		return {
			status: 503,
			body: {
				error: 'temporarily_unavailable',
				error_description: 'the wiki could not check subject_token',
			},
		};
	}

	const lifetimeMs = subjectToken.expiresAt - Date.now();
	if (lifetimeMs < 1000) {
		return bad('invalid_request', 'subject_token has expired');
	}
	const upstreamTokenId = exchangedTokenId(pc.wikiKey, subjectToken, profile.sub);
	storeExchangedToken(store, upstreamTokenId, {
		accessToken: subjectToken.token,
		expiresAt: subjectToken.expiresAt,
		wikiKey: pc.wikiKey,
	});
	const ttlMs = Math.min(pc.tokenTtlMs, lifetimeMs);
	const accessToken = await mintAccessToken({
		issuer: pc.issuer,
		signingKey: pc.signingKey,
		upstreamTokenId,
		ttlMs,
		scopes: [],
	});
	return {
		status: 200,
		body: {
			access_token: accessToken,
			issued_token_type: ACCESS_TOKEN_TYPE,
			token_type: 'Bearer',
			expires_in: Math.floor(ttlMs / 1000),
		},
	};
}

function refuseRequest(body: Record<string, unknown>, pc: ProxyConfig): TokenResult | undefined {
	if (body.subject_token_type !== ACCESS_TOKEN_TYPE) {
		return bad('invalid_request', `subject_token_type must be ${ACCESS_TOKEN_TYPE}`);
	}
	if (body.requested_token_type !== undefined && body.requested_token_type !== ACCESS_TOKEN_TYPE) {
		return bad('invalid_request', `requested_token_type must be ${ACCESS_TOKEN_TYPE}`);
	}
	if (body.actor_token !== undefined) {
		return bad('invalid_request', 'actor_token is not supported');
	}
	if (body.scope !== undefined) {
		return bad('invalid_scope', "the issued token has the wiki token's grants; omit scope");
	}
	for (const target of [body.resource, body.audience]) {
		if (
			target !== undefined &&
			!(typeof target === 'string' && isThisResource(target, pc.issuer))
		) {
			return bad('invalid_target', 'resource and audience may only name this server');
		}
	}
	return undefined;
}

// Its claims are read without verifying them: the wiki's acceptance of the token vouches for them.
function readSubjectToken(token: unknown): SubjectToken | undefined {
	if (typeof token !== 'string') {
		return undefined;
	}
	let payload;
	try {
		payload = decodeJwt(token);
	} catch {
		return undefined;
	}
	if (typeof payload.aud !== 'string' || typeof payload.exp !== 'number') {
		return undefined;
	}
	return {
		token,
		consumer: payload.aud,
		grants: grantsOf(payload.scopes),
		expiresAt: payload.exp * 1000,
	};
}

// Extension:OAuth lists a token's grants in its `scopes` claim.
function grantsOf(scopes: unknown): string[] {
	if (!Array.isArray(scopes)) {
		return [];
	}
	return scopes.filter((scope): scope is string => typeof scope === 'string').sort();
}

// One id per user, consumer and grant set: their next exchange of such a token
// lands on the same record and rate limit.
function exchangedTokenId(wikiKey: string, subjectToken: SubjectToken, user: string): string {
	const digest = createHash('sha256').update(
		JSON.stringify([wikiKey, subjectToken.consumer, subjectToken.grants, user]),
	);
	return `exchange-${digest.digest('base64url')}`;
}

function storeExchangedToken(store: ProxyStore, id: string, token: UpstreamToken): void {
	const stored = store.getUpstreamToken(id);
	if (!stored || stored.expiresAt < token.expiresAt) {
		store.setUpstreamToken(id, token);
	}
}

function bad(error: string, description: string): TokenResult {
	return { status: 400, body: { error, error_description: description } };
}
