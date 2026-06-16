import { describe, it, expect } from 'vitest';
import { planAuthorize } from '../../../src/auth/authorizationServer/authorize.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';

const pc = {
	issuer: 'https://wiki.example/mcp',
	authorizeBase: 'https://wiki.example',
	scriptpath: '/w',
	callbackUrl: 'https://wiki.example/mcp/oauth/callback',
	upstreamClientId: 'UP',
	signingKey: 'k'.repeat(32),
	consentTtlMs: 60_000,
	// oxlint-disable-next-line typescript/no-explicit-any -- partial ProxyConfig stub for pure-function tests
} as any;

function setup() {
	const store = new InMemoryProxyStore();
	const client = store.putClient({
		redirectUris: ['http://127.0.0.1:9000/cb'],
		scopes: ['editpage'],
		name: 'Claude Code',
	});
	return { store, client };
}

const baseQuery = (clientId: string) => ({
	client_id: clientId,
	redirect_uri: 'http://127.0.0.1:9000/cb',
	state: 'cstate',
	code_challenge: 'CCH',
	code_challenge_method: 'S256',
	scope: 'editpage',
});

describe('planAuthorize', () => {
	it('errors on unknown client', () => {
		const { store } = setup();
		expect(planAuthorize(baseQuery('nope'), undefined, pc, store, 'Ex').kind).toBe('error');
	});
	it('errors on unregistered redirect', () => {
		const { store, client } = setup();
		expect(
			planAuthorize(
				{ ...baseQuery(client.clientId), redirect_uri: 'http://127.0.0.1:9999/cb' },
				undefined,
				pc,
				store,
				'Ex',
			).kind,
		).toBe('error');
	});
	it('errors on resource mismatch', () => {
		const { store, client } = setup();
		expect(
			planAuthorize(
				{ ...baseQuery(client.clientId), resource: 'https://other' },
				undefined,
				pc,
				store,
				'Ex',
			).kind,
		).toBe('error');
	});
	it('accepts a resource equal to the issuer with a trailing slash (RFC 8707)', () => {
		// A spec-compliant client echoes the protected-resource doc's `resource`
		// (resolvePublicBase guarantees a trailing slash), which differs from the
		// slash-free RFC 8414 issuer only by that slash. It must NOT be rejected.
		const { store, client } = setup();
		expect(
			planAuthorize(
				{ ...baseQuery(client.clientId), resource: `${pc.issuer}/` },
				undefined,
				pc,
				store,
				'Ex',
			).kind,
		).not.toBe('error');
	});
	it('still errors on a genuinely different resource (not just a trailing slash)', () => {
		const { store, client } = setup();
		expect(
			planAuthorize(
				{ ...baseQuery(client.clientId), resource: 'https://wiki.example/other' },
				undefined,
				pc,
				store,
				'Ex',
			).kind,
		).toBe('error');
	});
	it('errors when code_challenge_method is not S256', () => {
		const { store, client } = setup();
		expect(
			planAuthorize(
				{ ...baseQuery(client.clientId), code_challenge_method: 'plain' },
				undefined,
				pc,
				store,
				'Ex',
			).kind,
		).toBe('error');
	});
	it('errors when code_challenge is missing', () => {
		const { store, client } = setup();
		const q = baseQuery(client.clientId);
		delete (q as Record<string, unknown>).code_challenge;
		expect(planAuthorize(q, undefined, pc, store, 'Ex').kind).toBe('error');
	});
	it('renders consent when no cookie', () => {
		const { store, client } = setup();
		expect(planAuthorize(baseQuery(client.clientId), undefined, pc, store, 'Ex').kind).toBe(
			'consent',
		);
	});
	it('redirects upstream with a stored txn when consent present', () => {
		const { store, client } = setup();
		const r = planAuthorize(
			baseQuery(client.clientId),
			{ clientId: client.clientId, redirectHost: '127.0.0.1', wiki: 'w' },
			pc,
			store,
			'Ex',
		);
		expect(r.kind).toBe('redirect');
		if (r.kind !== 'redirect') return;
		const u = new URL(r.location);
		expect(u.origin + u.pathname).toBe('https://wiki.example/w/rest.php/oauth2/authorize');
		expect(u.searchParams.get('client_id')).toBe('UP');
		expect(u.searchParams.get('redirect_uri')).toBe('https://wiki.example/mcp/oauth/callback');
		expect(u.searchParams.get('code_challenge_method')).toBe('S256');
		const txnId = u.searchParams.get('state')!;
		expect(store.getTransaction(txnId)?.clientCodeChallenge).toBe('CCH');
		expect(store.getTransaction(txnId)?.proxyVerifier).toBeTruthy();
	});
});
