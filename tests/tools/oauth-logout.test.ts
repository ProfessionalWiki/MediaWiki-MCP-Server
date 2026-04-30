import { describe, expect, it, vi } from 'vitest';
import { oauthLogout } from '../../src/tools/oauth-logout.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { useTempTokenStore } from '../helpers/tempTokenStore.js';
import { createTokenStore } from '../../src/auth/tokenStore.js';
import { fakeContext } from '../helpers/fakeContext.js';

useTempTokenStore();

const tok = {
	access_token: 'a',
	refresh_token: 'r',
	expires_at: '2026-04-30T12:00:00.000Z',
	scopes: [] as string[],
	obtained_at: '2026-04-29T12:00:00.000Z',
};

describe('oauth-logout', () => {
	it('removes all tokens by default', async () => {
		const store = createTokenStore();
		await store.put('k1', tok);
		await store.put('k2', tok);
		await dispatch(oauthLogout, fakeContext())({});
		const after = await store.read();
		expect(Object.keys(after.tokens)).toEqual([]);
	});

	it('removes only the specified wiki', async () => {
		const store = createTokenStore();
		await store.put('k1', tok);
		await store.put('k2', tok);
		await dispatch(oauthLogout, fakeContext())({ wiki: 'k1' });
		const after = await store.read();
		expect(Object.keys(after.tokens)).toEqual(['k2']);
	});

	it('returns removed list in result', async () => {
		const store = createTokenStore();
		await store.put('k1', tok);
		await store.put('k2', tok);
		const result = await dispatch(oauthLogout, fakeContext())({});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('k1');
		expect(text).toContain('k2');
		expect(result.isError).toBeFalsy();
	});

	it('returns empty removed list when wiki does not exist', async () => {
		const result = await dispatch(oauthLogout, fakeContext())({ wiki: 'nonexistent' });
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Removed');
		expect(result.isError).toBeFalsy();
	});

	it('logs oauth_token_revoked event for each removed wiki', async () => {
		const store = createTokenStore();
		await store.put('k1', tok);
		await store.put('k2', tok);
		const ctx = fakeContext();
		await dispatch(oauthLogout, ctx)({});
		expect(ctx.logger.info).toHaveBeenCalledWith('', { event: 'oauth_token_revoked', wiki: 'k1' });
		expect(ctx.logger.info).toHaveBeenCalledWith('', { event: 'oauth_token_revoked', wiki: 'k2' });
	});

	it('does not log event when wiki key not found', async () => {
		const ctx = fakeContext();
		await dispatch(oauthLogout, ctx)({ wiki: 'ghost' });
		expect(vi.mocked(ctx.logger.info)).not.toHaveBeenCalled();
	});
});
