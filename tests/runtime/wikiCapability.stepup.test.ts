import { describe, it, expect } from 'vitest';
import { checkWikiCapability } from '../../src/runtime/wikiCapability.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { withRequestFields } from '../../src/runtime/requestContext.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';

const PROXY = {
	issuer: 'https://mcp.example/mcp',
	signingKey: 'k'.repeat(32),
	tokenExchangeBase: 'http://wiki.svc',
	scriptpath: '/w',
	upstreamClientId: 'UP',
} as unknown as ProxyConfig;

// An OAuth-only wiki (proxy requires oauth2ClientId on the default wiki).
const oauthWiki = {
	sitename: 'X',
	server: 'https://x',
	articlepath: '/wiki',
	scriptpath: '/w',
	oauth2ClientId: 'client-id',
} as never;

function ctx(opts: { proxy: boolean; transport?: 'http' | 'stdio' }) {
	return fakeContext({
		transport: opts.transport ?? 'http',
		getProxyConfig: opts.proxy ? () => PROXY : () => null,
		wikis: {
			getAll: () => ({ w: oauthWiki }) as never,
			get: (() => oauthWiki) as never,
			add: (() => {}) as never,
			remove: (() => {}) as never,
			isManagementAllowed: () => true,
		},
		wikiProbe: {
			hasExtension: (async () => true) as never,
			hasAnyExtension: (async () => true) as never,
			invalidate: (() => {}) as never,
			inspect: (async () => ({ reachable: true, extensions: new Set<string>() })) as never,
		},
	});
}

function messageOf(result: { content?: unknown[] } | undefined): string {
	const raw =
		(result?.content as { text?: string }[] | undefined)?.map((c) => c.text).join('') ?? '';
	return (JSON.parse(raw) as { message: string }).message;
}

describe('checkWikiCapability proxy step-up', () => {
	it('rejects a write tool dispatched anonymously on a proxy-enabled wiki with the step-up hint', async () => {
		const result = await checkWikiCapability('update-page', 'w', ctx({ proxy: true }));
		expect(result?.isError).toBe(true);
		const message = messageOf(result);
		expect(message).toContain('Authentication required to use write tools');
		expect(message).toContain(`${PROXY.issuer}/.well-known/oauth-protected-resource`);
	});

	it('allows a read tool dispatched anonymously on a proxy-enabled wiki', async () => {
		const result = await checkWikiCapability('get-page', 'w', ctx({ proxy: true }));
		expect(result).toBeUndefined();
	});

	it('allows a write tool when a runtime token is present on a proxy-enabled wiki', async () => {
		const result = await withRequestFields({ runtimeToken: 'upstream-tok' }, () =>
			checkWikiCapability('update-page', 'w', ctx({ proxy: true })),
		);
		expect(result).toBeUndefined();
	});

	it('rejects an extension write tool dispatched anonymously on a proxy-enabled wiki', async () => {
		const result = await checkWikiCapability('neowiki-create-subject', 'w', ctx({ proxy: true }));
		expect(result?.isError).toBe(true);
		expect(messageOf(result)).toContain('Authentication required to use write tools');
	});

	it('does not apply the proxy step-up on the stdio transport', async () => {
		const result = await checkWikiCapability(
			'update-page',
			'w',
			ctx({ proxy: true, transport: 'stdio' }),
		);
		expect(result).toBeUndefined();
	});

	it('falls back to the legacy blanket OAuth rejection (read tool too) when the proxy is disabled', async () => {
		// Proxy disabled, OAuth-only wiki, no token: the legacy guard rejects even a
		// read tool — proving the step-up only loosens behavior when the proxy is on.
		const result = await checkWikiCapability('get-page', 'w', ctx({ proxy: false }));
		expect(result?.isError).toBe(true);
		expect(messageOf(result)).toContain('requires OAuth');
	});
});
