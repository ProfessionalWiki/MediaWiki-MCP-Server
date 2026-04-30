import { describe, expect, it } from 'vitest';
import { oauthStatus } from '../../src/tools/oauth-status.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { useTempTokenStore } from '../helpers/tempTokenStore.js';
import { createTokenStore } from '../../src/auth/tokenStore.js';
import { fakeContext } from '../helpers/fakeContext.js';

useTempTokenStore();

describe('oauth-status', () => {
	it('returns scopes/expiry but never token values', async () => {
		await createTokenStore().put('k', {
			access_token: 'SECRET',
			refresh_token: 'SECRET-R',
			expires_at: '2026-04-30T12:00:00.000Z',
			scopes: ['edit'],
			obtained_at: '2026-04-29T12:00:00.000Z',
		});
		const result = await dispatch(oauthStatus, fakeContext())({});
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain('SECRET');
		expect(text).toContain('edit');
		expect(text).toContain('2026-04-30');
	});

	it('returns empty wikis list when no tokens stored', async () => {
		const result = await dispatch(oauthStatus, fakeContext())({});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('Wikis');
		expect(result.isError).toBeFalsy();
	});

	it('returns obtained_at and wiki key in output', async () => {
		await createTokenStore().put('mywiki', {
			access_token: 'tok',
			expires_at: '2026-12-01T00:00:00.000Z',
			scopes: ['read', 'write'],
			obtained_at: '2026-04-29T12:00:00.000Z',
		});
		const result = await dispatch(oauthStatus, fakeContext())({});
		const text = (result.content[0] as { text: string }).text;
		expect(text).toContain('mywiki');
		expect(text).toContain('2026-04-29');
		expect(text).not.toContain('tok');
	});
});
