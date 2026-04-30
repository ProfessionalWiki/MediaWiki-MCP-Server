// src/auth/acquireToken.ts
import { browserAuth } from './browserAuth.js';
import { fetchMetadata, type WikiSlice } from './metadata.js';
import { OAuthFlowError } from './oauthFlow.js';
import { refreshIfNeeded } from './tokenRefresh.js';
import { createTokenStore } from './tokenStore.js';

export interface AcquireCtx {
	wiki: WikiSlice;
	oauth2ClientId: string | undefined | null;
	scopes?: string[];
}

export async function acquireToken(wikiKey: string, ctx: AcquireCtx): Promise<string> {
	if (typeof ctx.oauth2ClientId !== 'string' || ctx.oauth2ClientId.trim() === '') {
		throw new Error(`Wiki '${wikiKey}' has no oauth2ClientId; cannot acquire OAuth token.`);
	}
	const cur = (await createTokenStore().read()).tokens[wikiKey];
	if (cur !== undefined) {
		try {
			const md = await fetchMetadata(wikiKey, ctx.wiki);
			return await refreshIfNeeded(wikiKey, {
				clientId: ctx.oauth2ClientId,
				metadata: md,
			});
		} catch (err: unknown) {
			if (err instanceof OAuthFlowError && err.kind === 'invalid_grant') {
				// Refresh token dead — tokenRefresh already deleted the entry.
				// Fall through to a fresh browser dance below.
			} else {
				throw err;
			}
		}
	}
	return browserAuth(wikiKey, {
		wiki: ctx.wiki,
		clientId: ctx.oauth2ClientId,
		scopes: ctx.scopes,
	});
}
