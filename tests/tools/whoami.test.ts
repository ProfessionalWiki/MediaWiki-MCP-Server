import { describe, it, expect, vi } from 'vitest';
import { whoami } from '../../src/tools/whoami.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.js';

function ctxWith(request: ReturnType<typeof vi.fn>) {
	const mwn = createMockMwn({ request });
	return fakeContext({ mwn: () => Promise.resolve(mwn as never) });
}

function userinfoResponse(overrides: Record<string, unknown> = {}) {
	return {
		query: {
			userinfo: {
				id: 12345,
				name: 'Alistair3149',
				groups: ['*', 'user', 'autoconfirmed', 'sysop'],
				...overrides,
			},
		},
	};
}

describe('whoami', () => {
	it('returns the authenticated user with groups and no rights by default', async () => {
		const request = vi.fn().mockResolvedValue(userinfoResponse());
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(whoami, ctx)({} as never));

		expect(data.id).toBe(12345);
		expect(data.username).toBe('Alistair3149');
		expect(data.anonymous).toBe(false);
		expect(data.groups).toEqual(['*', 'user', 'autoconfirmed', 'sysop']);
		expect(data.rights).toBeUndefined();
		expect(data.wiki).toBe('test-wiki');
		expect(request).toHaveBeenCalledTimes(1);
		expect(request.mock.calls[0][0].uiprop).toBe('groups');
	});

	it('reports anonymous access instead of failing when no user is logged in', async () => {
		const request = vi
			.fn()
			.mockResolvedValue(
				userinfoResponse({ id: 0, name: '203.0.113.5', anon: true, groups: ['*'] }),
			);
		const ctx = ctxWith(request);

		const data = assertStructuredData(await dispatch(whoami, ctx)({} as never));

		expect(data.anonymous).toBe(true);
		expect(data.id).toBe(0);
		expect(data.username).toBe('203.0.113.5');
		expect(data.groups).toEqual(['*']);
	});

	it('includes rights and requests them only when includeRights is true', async () => {
		const request = vi
			.fn()
			.mockResolvedValue(userinfoResponse({ rights: ['read', 'edit', 'createpage', 'upload'] }));
		const ctx = ctxWith(request);

		const data = assertStructuredData(
			await dispatch(whoami, ctx)({ includeRights: true } as never),
		);

		expect(data.groups).toEqual(['*', 'user', 'autoconfirmed', 'sysop']);
		expect(data.rights).toEqual(['read', 'edit', 'createpage', 'upload']);
		expect(request.mock.calls[0][0].uiprop).toBe('groups|rights');
	});

	it('fails with upstream_failure when the response lacks userinfo', async () => {
		const request = vi.fn().mockResolvedValue({ query: {} });
		const ctx = ctxWith(request);

		const result = await dispatch(whoami, ctx)({} as never);

		assertStructuredError(result, 'upstream_failure');
	});
});
