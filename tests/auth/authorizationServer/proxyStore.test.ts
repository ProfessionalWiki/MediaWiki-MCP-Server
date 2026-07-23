import { describe, it, expect } from 'vitest';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';

describe('InMemoryProxyStore stats', () => {
	it('reports upstream-token and client counts', () => {
		const s = new InMemoryProxyStore();
		expect(s.stats()).toEqual({ upstreamTokens: 0, clients: 0 });
		s.putClient({ redirectUris: ['http://127.0.0.1/cb'], scopes: [], name: 'c' });
		const id = s.putUpstreamToken({ accessToken: 'a', expiresAt: Date.now() + 1000 });
		s.putUpstreamToken({ accessToken: 'b', expiresAt: Date.now() + 1000 });
		expect(s.stats()).toEqual({ upstreamTokens: 2, clients: 1 });
		s.deleteUpstreamToken(id);
		expect(s.stats()).toEqual({ upstreamTokens: 1, clients: 1 });
	});
});

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
	it('updateUpstreamToken preserves refreshId not carried by the update', () => {
		const s = new InMemoryProxyStore();
		const id = s.putUpstreamToken({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
		s.setRefreshId(id, 'RID');
		s.updateUpstreamToken(id, { accessToken: 'a2', refreshToken: 'r2', expiresAt: 2 });
		expect(s.getUpstreamToken(id)?.refreshId).toBe('RID');
	});
	it('does not resurrect a deleted upstream token on update', () => {
		const s = new InMemoryProxyStore();
		const id = s.putUpstreamToken({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
		s.deleteUpstreamToken(id);
		s.updateUpstreamToken(id, { accessToken: 'a2', expiresAt: 2 });
		expect(s.getUpstreamToken(id)).toBeUndefined();
	});
	it('claims a refresh rotation once and rejects a concurrent or stale claim', () => {
		const s = new InMemoryProxyStore();
		const id = s.putUpstreamToken({ accessToken: 'a', refreshToken: 'r', expiresAt: 1 });
		s.setRefreshId(id, 'R0');
		expect(s.beginRefreshRotation(id, 'R0')).toBe(true);
		// A second claim while one is in flight is rejected (concurrent reuse).
		expect(s.beginRefreshRotation(id, 'R0')).toBe(false);
		// Committing rotates the rid; the old rid no longer claims, the new one does.
		s.finishRefreshRotation(id, 'R1');
		expect(s.beginRefreshRotation(id, 'R0')).toBe(false);
		expect(s.beginRefreshRotation(id, 'R1')).toBe(true);
		// Abandoning (no new rid) leaves the current rid valid for a retry.
		s.finishRefreshRotation(id);
		expect(s.beginRefreshRotation(id, 'R1')).toBe(true);
	});
});

describe('InMemoryProxyStore durable snapshot', () => {
	it('round-trips clients (order preserved) and upstream tokens', () => {
		const a = new InMemoryProxyStore();
		const c1 = a.putClient({ redirectUris: ['r1'], scopes: [], name: 'c1' });
		const c2 = a.putClient({ redirectUris: ['r2'], scopes: [], name: 'c2' });
		const id = a.putUpstreamToken({
			accessToken: 'at',
			refreshToken: 'rt',
			expiresAt: 5,
			refreshId: 'rid',
		});
		const snap = a.snapshotDurable();

		const b = new InMemoryProxyStore();
		b.restoreDurable(snap);
		expect(b.getClient(c1.clientId)?.name).toBe('c1');
		expect(b.getClient(c2.clientId)?.name).toBe('c2');
		expect(b.getUpstreamToken(id)).toEqual({
			accessToken: 'at',
			refreshToken: 'rt',
			expiresAt: 5,
			refreshId: 'rid',
		});
	});

	it('clears prior durable state and leaves ephemeral empty on restore', () => {
		const b = new InMemoryProxyStore();
		b.putClient({ redirectUris: ['old'], scopes: [], name: 'old' });
		b.restoreDurable({ version: 1, clients: [], upstream: [] });
		expect(b.getUpstreamToken('x')).toBeUndefined();
	});

	it('rejects an unknown snapshot version', () => {
		const b = new InMemoryProxyStore();
		// oxlint-disable-next-line typescript/no-explicit-any -- deliberately malformed for the test
		expect(() => b.restoreDurable({ version: 2 } as any)).toThrow();
	});

	it('preserves FIFO eviction order across a snapshot restore', () => {
		const a = new InMemoryProxyStore(Date.now, 2); // client cap of 2
		const c1 = a.putClient({ redirectUris: ['r1'], scopes: [], name: 'c1' });
		a.putClient({ redirectUris: ['r2'], scopes: [], name: 'c2' });
		const b = new InMemoryProxyStore(Date.now, 2);
		b.restoreDurable(a.snapshotDurable());
		// Adding a third client must evict the OLDEST (c1), proving insertion order survived.
		b.putClient({ redirectUris: ['r3'], scopes: [], name: 'c3' });
		expect(b.getClient(c1.clientId)).toBeUndefined();
	});
});
