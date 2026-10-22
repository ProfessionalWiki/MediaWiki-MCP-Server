// src/auth/stdioSignIn.ts
import { browserAuth } from './browserAuth.ts';
import { fetchMetadata, type WikiSlice } from './metadata.ts';
import { OAuthFlowError } from './oauthFlow.ts';
import { refreshIfNeeded } from './tokenRefresh.ts';
import { createTokenStore } from './tokenStore.ts';
import { usesOAuthSignIn } from '../runtime/authShape.ts';

export interface AcquireCtx {
	wiki: WikiSlice;
	oauth2ClientId: string | undefined | null;
	scopes?: string[];
	callbackPort?: number;
}

/** The stdio server signing in to OAuth wikis itself, with the user's browser. */
export class StdioSignIn {
	// Concurrent calls to one wiki share one refresh or one browser sign-in.
	private readonly pending = new Map<string, Promise<string>>();

	public acquire(wikiKey: string, ctx: AcquireCtx): Promise<string> {
		const existing = this.pending.get(wikiKey);
		if (existing !== undefined) {
			return existing;
		}
		const pending = acquireToken(wikiKey, ctx).finally(() => {
			this.pending.delete(wikiKey);
		});
		this.pending.set(wikiKey, pending);
		return pending;
	}
}

async function acquireToken(wikiKey: string, ctx: AcquireCtx): Promise<string> {
	if (!usesOAuthSignIn(ctx)) {
		throw new Error(`Wiki '${wikiKey}' has no oauth2ClientId; cannot acquire OAuth token.`);
	}
	const cur = (await createTokenStore().read()).tokens[wikiKey];
	if (cur !== undefined) {
		try {
			const md = await fetchMetadata(wikiKey, ctx.wiki);
			// A token another issuer granted, under a key since pointed at a different
			// wiki, is replaced by signing in again rather than sent there.
			if (cur.issuer === undefined || cur.issuer === md.issuer) {
				return await refreshIfNeeded(wikiKey, { clientId: ctx.oauth2ClientId, metadata: md }, cur);
			}
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
