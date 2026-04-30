// src/auth/tokenRefresh.ts
import { logger } from '../runtime/logger.js';
import { OAuthFlowError, refreshTokens } from './oauthFlow.js';
import { createTokenStore } from './tokenStore.js';
import type { AsMetadata } from './metadata.js';

const REFRESH_THRESHOLD_MS = 60_000;

export interface RefreshContext {
	clientId: string;
	metadata: Pick<AsMetadata, 'token_endpoint'>;
}

const inFlight = new Map<string, Promise<string>>();

export function _resetRefreshDedupForTesting(): void {
	inFlight.clear();
}

export async function refreshIfNeeded(wikiKey: string, ctx: RefreshContext): Promise<string> {
	const store = createTokenStore();
	const creds = await store.read();
	const cur = creds.tokens[wikiKey];

	if (cur === undefined) {
		throw new Error(`No stored token for wiki ${wikiKey}`);
	}

	const expiresAt = new Date(cur.expires_at).getTime();
	const now = Date.now();

	if (expiresAt - now > REFRESH_THRESHOLD_MS) {
		return cur.access_token;
	}

	if (cur.refresh_token === undefined) {
		throw new OAuthFlowError('invalid_grant', 'Stored token expired with no refresh_token');
	}

	const existing = inFlight.get(wikiKey);
	if (existing !== undefined) {
		return existing;
	}

	const pending = doRefresh(wikiKey, ctx, cur.refresh_token, cur.scopes).finally(() => {
		inFlight.delete(wikiKey);
	});
	inFlight.set(wikiKey, pending);
	return pending;
}

async function doRefresh(
	wikiKey: string,
	ctx: RefreshContext,
	refreshToken: string,
	currentScopes: string[],
): Promise<string> {
	const store = createTokenStore();

	let tok: Awaited<ReturnType<typeof refreshTokens>>;
	try {
		tok = await refreshTokens({
			tokenEndpoint: ctx.metadata.token_endpoint,
			refreshToken,
			clientId: ctx.clientId,
		});
	} catch (err: unknown) {
		if (err instanceof OAuthFlowError) {
			logger.info('', {
				event: 'oauth_refresh_failed',
				wiki: wikiKey,
				reason: err.kind,
			});
			if (err.kind === 'invalid_grant') {
				await store.delete(wikiKey);
			}
		}
		throw err;
	}

	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const expiresAtIso = new Date(nowMs + tok.expires_in * 1000).toISOString();

	await store.put(wikiKey, {
		access_token: tok.access_token,
		refresh_token: tok.refresh_token ?? refreshToken,
		expires_at: expiresAtIso,
		scopes: tok.scope !== undefined ? tok.scope.split(' ') : currentScopes,
		obtained_at: nowIso,
	});

	return tok.access_token;
}
