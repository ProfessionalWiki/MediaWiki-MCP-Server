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
	callbackPort?: number;
}

export async function acquireToken(wikiKey: string, ctx: AcquireCtx): Promise<string> {
	if (typeof ctx.oauth2ClientId !== 'string' || ctx.oauth2ClientId.trim() === '') {
		throw new Error(`Wiki '${wikiKey}' has no oauth2ClientId; cannot acquire OAuth token.`);
	}
	const cur = (await createTokenStore().read()).tokens[wikiKey];
	if (cur !== undefined) {
		try {
			const md = await fetchMetadata(wikiKey, ctx.wiki);
			return await refreshIfNeeded(wikiKey, { clientId: ctx.oauth2ClientId, metadata: md }, cur);
		} catch (err: unknown) {
			// Only invalid_grant means the stored token is dead and a fresh dance
			// will recover. tokenRefresh already deleted the entry. Other errors
			// (transient network, invalid_client, MetadataError) propagate — a
			// fresh dance against the same broken AS would not help.
			if (!(err instanceof OAuthFlowError) || err.kind !== 'invalid_grant') {
				throw err;
			}
		}
	}
	return browserAuth(wikiKey, {
		wiki: ctx.wiki,
		clientId: ctx.oauth2ClientId,
		scopes: ctx.scopes,
		callbackPort: ctx.callbackPort,
	});
}
