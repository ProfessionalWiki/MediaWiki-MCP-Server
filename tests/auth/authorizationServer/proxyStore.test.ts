import { describe, it, expect } from 'vitest';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';

describe('InMemoryProxyStore', () => {
	it('registers and reads a client', () => {
		const s = new InMemoryProxyStore();
		const c = s.putClient({
			redirectUris: ['http://127.0.0.1:9000/callback'],
			scopes: ['editpage'],
			name: 'Claude Code',
		});
		expect(s.getClient(c.clientId)?.name).toBe('Claude Code');
	});
	it('caps the clients map with FIFO eviction (oldest gone, size held)', () => {
		const MAX = 3;
		const s = new InMemoryProxyStore(Date.now, MAX);
		const ids: string[] = [];
		// Register one more than the cap allows.
		for (let i = 0; i < MAX + 1; i++) {
			ids.push(
				s.putClient({
					redirectUris: ['http://127.0.0.1:9000/callback'],
					scopes: [],
					name: `c${i}`,
				}).clientId,
			);
		}
		// The oldest registration was evicted; the rest survive.
		expect(s.getClient(ids[0])).toBeUndefined();
		for (const id of ids.slice(1)) {
			expect(s.getClient(id)).toBeDefined();
		}
		// One more registration keeps the size pinned at the cap (no growth).
		s.putClient({ redirectUris: ['http://127.0.0.1:9000/callback'], scopes: [], name: 'extra' });
		expect(s.getClient(ids[1])).toBeUndefined();
		expect(s.getClient(ids[2])).toBeDefined();
	});
	it('consumes a one-time code exactly once', () => {
		const s = new InMemoryProxyStore();
		s.putCode('code-1', {
			clientId: 'c',
			clientRedirectUri: 'http://127.0.0.1:9000/callback',
			clientCodeChallenge: 'x',
			scopes: [],
			upstreamTokenId: 't1',
		});
		expect(s.consumeCode('code-1')?.upstreamTokenId).toBe('t1');
		expect(s.consumeCode('code-1')).toBeUndefined();
	});
	it('expires a transaction past its TTL', () => {
		let now = 1000;
		const s = new InMemoryProxyStore(() => now);
		s.putTransaction(
			'txn-1',
			{
				clientId: 'c',
				clientRedirectUri: 'r',
				clientState: 's',
				clientCodeChallenge: 'x',
				clientCodeChallengeMethod: 'S256',
				scopes: [],
				proxyVerifier: 'v',
			},
			100,
		);
		now = 1050;
		expect(s.getTransaction('txn-1')).toBeDefined();
		now = 1200;
		expect(s.getTransaction('txn-1')).toBeUndefined();
	});
	it('stores and updates an upstream token by id', () => {
		const s = new InMemoryProxyStore();
		const id = s.putUpstreamToken({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
		expect(s.getUpstreamToken(id)?.accessToken).toBe('a');
		s.updateUpstreamToken(id, { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 });
		expect(s.getUpstreamToken(id)?.accessToken).toBe('a2');
	});
});
