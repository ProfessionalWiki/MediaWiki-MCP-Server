import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import {
	initMetrics,
	getMetricsHandler,
	__resetMetricsForTesting,
} from '../../../src/runtime/metrics.js';
import type { ProxyConfig } from '../../../src/auth/authorizationServer/proxyConfig.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';
import {
	PersistentProxyStore,
	ProxyStorePersistenceError,
	createProxyStore,
} from '../../../src/auth/authorizationServer/proxyStorePersistence.js';
import { deriveKey, encrypt } from '../../../src/auth/authorizationServer/proxyStoreCrypto.js';

const SIGNING_KEY = 'test-signing-key-of-at-least-32-chars!!';
const KEY = deriveKey(SIGNING_KEY);
const tick = (): Promise<void> => new Promise((r) => setImmediate(r));

function make(file: string): PersistentProxyStore {
	const s = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
	s.hydrate();
	return s;
}

describe('PersistentProxyStore', () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-proxy-'));
		file = path.join(dir, 'proxy-store.enc');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it('writes an upstream token through synchronously and rehydrates it', () => {
		const s1 = make(file);
		const id = s1.putUpstreamToken({ accessToken: 'at', refreshToken: 'rt', expiresAt: 111 });
		expect(fs.existsSync(file)).toBe(true);
		const s2 = make(file);
		expect(s2.getUpstreamToken(id)).toEqual({
			accessToken: 'at',
			refreshToken: 'rt',
			expiresAt: 111,
		});
	});

	it('records a flush-duration metric on a durable write when metrics are enabled', async () => {
		vi.stubEnv('MCP_METRICS', 'true');
		__resetMetricsForTesting();
		initMetrics();
		try {
			const s = make(file);
			s.putUpstreamToken({ accessToken: 'a', expiresAt: 111 }); // write-through → flushSync
			const handler = getMetricsHandler();
			expect(handler).toBeDefined();
			const app = express();
			app.get('/metrics', handler!);
			const res = await request(app).get('/metrics');
			expect(res.text).toMatch(/mcp_proxy_store_flush_duration_seconds_count [1-9]/);
		} finally {
			__resetMetricsForTesting();
		}
	});

	it('increments the flush-failure counter when a durable write cannot be persisted', async () => {
		vi.stubEnv('MCP_METRICS', 'true');
		__resetMetricsForTesting();
		initMetrics();
		try {
			// Force flushSync to fail: put the store file under a path whose parent is a
			// regular file, so the mkdirSync/write throws.
			const blocker = path.join(dir, 'blocker');
			fs.writeFileSync(blocker, 'x');
			const onError = vi.fn();
			const s = new PersistentProxyStore(
				new InMemoryProxyStore(),
				path.join(blocker, 's.enc'),
				KEY,
				onError,
			);
			s.putUpstreamToken({ accessToken: 'a', expiresAt: 111 }); // write-through flush fails
			expect(onError).toHaveBeenCalledTimes(1); // the failure path ran, but did not throw
			const handler = getMetricsHandler();
			expect(handler).toBeDefined();
			const app = express();
			app.get('/metrics', handler!);
			const res = await request(app).get('/metrics');
			expect(res.text).toMatch(/mcp_proxy_store_flush_failures_total 1/);
		} finally {
			__resetMetricsForTesting();
		}
	});

	it('persists a client registration via the coalesced deferred flush', async () => {
		const s1 = make(file);
		const c = s1.putClient({
			redirectUris: ['http://127.0.0.1:9000/cb'],
			scopes: ['editpage'],
			name: 'Client',
		});
		await tick();
		const s2 = make(file);
		expect(s2.getClient(c.clientId)?.name).toBe('Client');
	});

	it('keeps refresh-token reuse detection working across a restart', () => {
		const s1 = make(file);
		const id = s1.putUpstreamToken({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });
		s1.setRefreshId(id, 'rid-A');
		expect(s1.beginRefreshRotation(id, 'rid-A')).toBe(true);
		s1.finishRefreshRotation(id, 'rid-B');
		const s2 = make(file);
		expect(s2.beginRefreshRotation(id, 'rid-A')).toBe(false);
		expect(s2.beginRefreshRotation(id, 'rid-B')).toBe(true);
	});

	it('does not rewrite the file when a refresh rotation is abandoned', () => {
		const s = make(file);
		const id = s.putUpstreamToken({ accessToken: 'at', refreshToken: 'rt', expiresAt: 1 });
		s.setRefreshId(id, 'rid-A');
		const before = fs.readFileSync(file);
		expect(s.beginRefreshRotation(id, 'rid-A')).toBe(true);
		s.finishRefreshRotation(id); // abandon: no newRefreshId → must NOT persist
		const after = fs.readFileSync(file);
		// encrypt() uses a fresh random IV per write, so ANY flush would change the bytes.
		expect(after.equals(before)).toBe(true);
	});

	it('best-effort: a failed write does not break the live request', () => {
		const blocker = path.join(dir, 'blocker');
		fs.writeFileSync(blocker, 'i am a file, not a dir');
		const errors: Error[] = [];
		const s = new PersistentProxyStore(
			new InMemoryProxyStore(),
			path.join(blocker, 'store.enc'), // parent is a file → mkdir/write fails
			KEY,
			(e) => errors.push(e),
		);
		const id = s.putUpstreamToken({ accessToken: 'at', expiresAt: 1 }); // must NOT throw
		expect(errors.length).toBeGreaterThan(0);
		expect(s.getUpstreamToken(id)?.accessToken).toBe('at'); // in-memory still resolves
	});

	it('does not read the file on the hot read path', () => {
		const s1 = make(file);
		const id = s1.putUpstreamToken({ accessToken: 'at', expiresAt: 1 });
		fs.rmSync(file);
		expect(s1.getUpstreamToken(id)?.accessToken).toBe('at');
	});

	it('starts empty when the file is missing', () => {
		const s = make(path.join(dir, 'absent.enc'));
		expect(s.getUpstreamToken('whatever')).toBeUndefined();
	});

	it('refuses to start on an undecryptable file', () => {
		fs.writeFileSync(file, Buffer.from('not a valid envelope'));
		const s = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
		expect(() => s.hydrate()).toThrow(ProxyStorePersistenceError);
	});

	it('refuses to start when the key does not match', () => {
		const other = new PersistentProxyStore(
			new InMemoryProxyStore(),
			file,
			deriveKey('another-signing-key-32-characters-xx'),
		);
		other.putUpstreamToken({ accessToken: 'at', expiresAt: 1 });
		const s = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
		expect(() => s.hydrate()).toThrow(ProxyStorePersistenceError);
	});

	it('refuses to start on an unknown snapshot version', () => {
		fs.writeFileSync(
			file,
			encrypt(KEY, Buffer.from(JSON.stringify({ version: 2, clients: [], upstream: [] }))),
		);
		const s = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
		expect(() => s.hydrate()).toThrow(ProxyStorePersistenceError);
	});
});

describe('createProxyStore', () => {
	let dir: string;
	let file: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-proxy-f-'));
		file = path.join(dir, 'proxy-store.enc');
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it('returns a plain in-memory store when there is no proxy config', () => {
		expect(createProxyStore(null)).toBeInstanceOf(InMemoryProxyStore);
	});

	it('returns a hydrating persistent store when a proxy config is present', () => {
		vi.stubEnv('MCP_OAUTH_PROXY_STORE_FILE', file);
		const pc = { signingKey: SIGNING_KEY } as ProxyConfig;
		const s = createProxyStore(pc);
		const id = s.putUpstreamToken({ accessToken: 'at', expiresAt: 1 });
		expect(fs.existsSync(file)).toBe(true);
		expect(createProxyStore(pc).getUpstreamToken(id)?.accessToken).toBe('at');
	});
});
