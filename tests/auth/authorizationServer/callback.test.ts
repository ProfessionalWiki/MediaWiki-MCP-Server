import { describe, it, expect, vi } from 'vitest';
import { handleCallback } from '../../../src/auth/authorizationServer/callback.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';
import type { ProxyConfig } from '../../../src/auth/authorizationServer/proxyConfig.js';

const pc: ProxyConfig = {
	issuer: 'https://wiki.example/mcp',
	authorizeBase: 'https://wiki.example',
	tokenExchangeBase: 'http://mediawiki.svc:80',
	scriptpath: '/w',
	callbackUrl: 'https://wiki.example/mcp/oauth/callback',
	upstreamClientId: 'UP',
	signingKey: 'x'.repeat(32),
	consentTtlMs: 1000,
	tokenTtlMs: 1000,
};

describe('handleCallback', () => {
	it('exchanges, stores the upstream token, and redirects with a one-time code', async () => {
		const store = new InMemoryProxyStore();
		store.putTransaction('txn-1', {
			clientId: 'cid',
			clientRedirectUri: 'http://127.0.0.1:9000/cb',
			clientState: 'cstate',
			clientCodeChallenge: 'CCH',
			clientCodeChallengeMethod: 'S256',
			scopes: ['editpage'],
			proxyVerifier: 'PV',
		});
		const exchange = vi
			.fn()
			.mockResolvedValue({ access_token: 'WA', refresh_token: 'WR', expires_in: 3600 });

		const r = await handleCallback({ code: 'WIKICODE', state: 'txn-1' }, pc, store, true, exchange);

		expect(exchange).toHaveBeenCalledWith(
			expect.objectContaining({
				tokenEndpoint: 'http://mediawiki.svc:80/w/rest.php/oauth2/access_token',
				code: 'WIKICODE',
				redirectUri: 'https://wiki.example/mcp/oauth/callback',
				clientId: 'UP',
				verifier: 'PV',
			}),
		);
		expect(r.kind).toBe('redirect');
		if (r.kind !== 'redirect') {
			return;
		}
		const u = new URL(r.location);
		expect(u.origin + u.pathname).toBe('http://127.0.0.1:9000/cb');
		const code = u.searchParams.get('code')!;
		expect(u.searchParams.get('state')).toBe('cstate');
		expect(u.searchParams.get('iss')).toBe('https://wiki.example/mcp');
		const consumed = store.consumeCode(code)!;
		expect(consumed.clientId).toBe('cid');
		expect(consumed.clientRedirectUri).toBe('http://127.0.0.1:9000/cb');
		expect(consumed.clientCodeChallenge).toBe('CCH');
		expect(consumed.scopes).toEqual(['editpage']);
		expect(store.getUpstreamToken(consumed.upstreamTokenId)?.accessToken).toBe('WA');
		expect(store.getUpstreamToken(consumed.upstreamTokenId)?.refreshToken).toBe('WR');
		expect(store.getTransaction('txn-1')).toBeUndefined();
	});

	it('omits the state param when clientState is empty', async () => {
		const store = new InMemoryProxyStore();
		store.putTransaction('txn-2', {
			clientId: 'cid',
			clientRedirectUri: 'http://127.0.0.1:9000/cb',
			clientState: '',
			clientCodeChallenge: 'CCH',
			clientCodeChallengeMethod: 'S256',
			scopes: ['editpage'],
			proxyVerifier: 'PV',
		});
		const exchange = vi.fn().mockResolvedValue({ access_token: 'WA', expires_in: 3600 });

		const r = await handleCallback({ code: 'WIKICODE', state: 'txn-2' }, pc, store, true, exchange);

		expect(r.kind).toBe('redirect');
		if (r.kind !== 'redirect') {
			return;
		}
		const u = new URL(r.location);
		expect(u.searchParams.has('state')).toBe(false);
		expect(u.searchParams.get('iss')).toBe('https://wiki.example/mcp');
	});

	it('errors on unknown txn without exchanging', async () => {
		const store = new InMemoryProxyStore();
		const exchange = vi.fn();
		const r = await handleCallback({ code: 'X', state: 'missing' }, pc, store, true, exchange);
		expect(r.kind).toBe('error');
		expect(exchange).not.toHaveBeenCalled();
	});

	it('errors when consent is not present, without exchanging', async () => {
		const store = new InMemoryProxyStore();
		store.putTransaction('txn-3', {
			clientId: 'cid',
			clientRedirectUri: 'http://127.0.0.1:9000/cb',
			clientState: 'cstate',
			clientCodeChallenge: 'CCH',
			clientCodeChallengeMethod: 'S256',
			scopes: ['editpage'],
			proxyVerifier: 'PV',
		});
		const exchange = vi.fn();
		const r = await handleCallback({ code: 'X', state: 'txn-3' }, pc, store, false, exchange);
		expect(r.kind).toBe('error');
		expect(exchange).not.toHaveBeenCalled();
		// Transaction must survive a denied attempt.
		expect(store.getTransaction('txn-3')).toBeDefined();
	});

	it('errors when code or state is missing', async () => {
		const store = new InMemoryProxyStore();
		const exchange = vi.fn();
		expect((await handleCallback({ state: 'txn-1' }, pc, store, true, exchange)).kind).toBe(
			'error',
		);
		expect((await handleCallback({ code: 'X' }, pc, store, true, exchange)).kind).toBe('error');
		expect(exchange).not.toHaveBeenCalled();
	});

	it('errors when the upstream exchange throws, leaving the txn intact', async () => {
		const store = new InMemoryProxyStore();
		store.putTransaction('txn-4', {
			clientId: 'cid',
			clientRedirectUri: 'http://127.0.0.1:9000/cb',
			clientState: 'cstate',
			clientCodeChallenge: 'CCH',
			clientCodeChallengeMethod: 'S256',
			scopes: ['editpage'],
			proxyVerifier: 'PV',
		});
		const exchange = vi.fn().mockRejectedValue(new Error('boom'));
		const r = await handleCallback({ code: 'WIKICODE', state: 'txn-4' }, pc, store, true, exchange);
		expect(r.kind).toBe('error');
		expect(store.getTransaction('txn-4')).toBeDefined();
	});
});
