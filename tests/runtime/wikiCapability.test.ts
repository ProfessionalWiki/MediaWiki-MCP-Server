import { describe, it, expect } from 'vitest';
import { checkWikiCapability } from '../../src/runtime/wikiCapability.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { withRequestFields } from '../../src/transport/requestContext.js';

const rwWiki = {
	sitename: 'X',
	server: 'https://x',
	articlepath: '/wiki',
	scriptpath: '/w',
} as never;
const roWiki = { ...rwWiki, readOnly: true } as never;
const oauthWiki = { ...rwWiki, oauth2ClientId: 'client-id' } as never;
const oauthWithTokenWiki = {
	...rwWiki,
	oauth2ClientId: 'client-id',
	token: 'static-token',
} as never;

function ctx(
	hasExt: boolean,
	wikiConfig: unknown,
	reachable = true,
	transport: 'http' | 'stdio' = 'stdio',
) {
	return fakeContext({
		transport,
		wikis: {
			getAll: () => ({ w: wikiConfig }) as never,
			get: (() => wikiConfig) as never,
			add: (() => {}) as never,
			remove: (() => {}) as never,
			isManagementAllowed: () => true,
		},
		extensions: {
			has: (async () => hasExt) as never,
			hasAny: (async () => hasExt) as never,
			invalidate: (() => {}) as never,
			inspect: (async () => ({ reachable, extensions: new Set<string>() })) as never,
		},
	});
}

describe('checkWikiCapability', () => {
	it('rejects an extension tool when the wiki lacks the extension', async () => {
		const result = await checkWikiCapability('cargo-query', 'w', ctx(false, rwWiki));
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain('not installed');
	});

	it('reports an unreachable wiki rather than claiming the extension is missing', async () => {
		const result = await checkWikiCapability('cargo-query', 'w', ctx(false, rwWiki, false));
		expect(result?.isError).toBe(true);
		const text = JSON.stringify(result?.content);
		expect(text).toContain('could not be reached');
		expect(text).not.toContain('not installed');
	});

	it('allows an extension tool when the wiki has the extension', async () => {
		expect(await checkWikiCapability('cargo-query', 'w', ctx(true, rwWiki))).toBeUndefined();
	});

	it('rejects a write tool against a read-only wiki', async () => {
		const result = await checkWikiCapability('update-page', 'w', ctx(true, roWiki));
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain('read-only');
	});

	it('allows a write tool against a writable wiki', async () => {
		expect(await checkWikiCapability('update-page', 'w', ctx(true, rwWiki))).toBeUndefined();
	});

	it('returns undefined for a plain read tool', async () => {
		expect(await checkWikiCapability('get-page', 'w', ctx(false, rwWiki))).toBeUndefined();
	});

	it('rejects an HTTP call to an OAuth-only wiki with no usable token', async () => {
		const result = await checkWikiCapability('get-page', 'w', ctx(false, oauthWiki, true, 'http'));
		expect(result?.isError).toBe(true);
		const raw = result?.content?.map((c) => (c as { text?: string }).text).join('') ?? '';
		const message = (JSON.parse(raw) as { message: string }).message;
		expect(message).toContain('requires OAuth');
		expect(message).toContain('Wiki "w"');
	});

	it('allows an HTTP call to an OAuth-only wiki when a runtime bearer is present', async () => {
		const result = await withRequestFields({ runtimeToken: 'tok' }, () =>
			checkWikiCapability('get-page', 'w', ctx(false, oauthWiki, true, 'http')),
		);
		expect(result).toBeUndefined();
	});

	it('allows an HTTP call to an OAuth wiki with static credentials configured', async () => {
		const result = await checkWikiCapability(
			'get-page',
			'w',
			ctx(false, oauthWithTokenWiki, true, 'http'),
		);
		expect(result).toBeUndefined();
	});

	it('fires the OAuth check before the extension check', async () => {
		// cargo-query is an extension tool, and the wiki lacks the extension; the
		// OAuth error must surface first.
		const result = await checkWikiCapability(
			'cargo-query',
			'w',
			ctx(false, oauthWiki, true, 'http'),
		);
		expect(result?.isError).toBe(true);
		expect(JSON.stringify(result?.content)).toContain('requires OAuth');
		expect(JSON.stringify(result?.content)).not.toContain('not installed');
	});

	it('does not fire the OAuth check on the stdio transport', async () => {
		const result = await checkWikiCapability('get-page', 'w', ctx(false, oauthWiki, true, 'stdio'));
		expect(result).toBeUndefined();
	});

	it('does not block an HTTP call to a non-OAuth wiki', async () => {
		const result = await checkWikiCapability('get-page', 'w', ctx(false, rwWiki, true, 'http'));
		expect(result).toBeUndefined();
	});
});
