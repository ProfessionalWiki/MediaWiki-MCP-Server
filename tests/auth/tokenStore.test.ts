// tests/auth/tokenStore.test.ts
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { createTokenStore, type StoredToken } from '../../src/auth/tokenStore.js';

let dir: string;
let file: string;

beforeEach(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-store-'));
	file = path.join(dir, 'credentials.json');
	vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', file);
});

afterEach(() => {
	fs.rmSync(dir, { recursive: true, force: true });
	vi.unstubAllEnvs();
});

const sample: StoredToken = {
	access_token: 'a',
	refresh_token: 'r',
	expires_at: '2026-04-30T12:34:56.000Z',
	scopes: ['edit'],
	obtained_at: '2026-04-29T11:34:56.000Z',
};

describe('tokenStore', () => {
	it('returns an empty store when the file is missing', async () => {
		const store = createTokenStore();
		expect(await store.read()).toEqual({ version: 1, tokens: {} });
	});
	it('round-trips a put through read', async () => {
		const store = createTokenStore();
		await store.put('wiki-a', sample);
		const got = await store.read();
		expect(got.tokens['wiki-a']).toEqual(sample);
	});
	it('writes the file mode as 0600 on Unix', async () => {
		if (process.platform === 'win32') {
			return;
		}
		const store = createTokenStore();
		await store.put('wiki-a', sample);
		const stat = fs.statSync(file);
		expect(stat.mode & 0o777).toBe(0o600);
	});
	it('delete removes the wiki entry but leaves others', async () => {
		const store = createTokenStore();
		await store.put('wiki-a', sample);
		await store.put('wiki-b', sample);
		await store.delete('wiki-a');
		const got = await store.read();
		expect(Object.keys(got.tokens)).toEqual(['wiki-b']);
	});
	it('refuses to operate on a corrupt JSON file', async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, '{ this is not json');
		const store = createTokenStore();
		await expect(store.read()).rejects.toThrow(/Credentials file at .* invalid JSON/);
	});
	it('refuses to operate on a version mismatch', async () => {
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, JSON.stringify({ version: 99, tokens: {} }));
		const store = createTokenStore();
		await expect(store.read()).rejects.toThrow(/unsupported version 99/);
	});
	it('serialises concurrent writes', async () => {
		const store = createTokenStore();
		await Promise.all(
			Array.from({ length: 25 }, (_, i) =>
				store.put(`wiki-${i}`, { ...sample, access_token: `tok-${i}` }),
			),
		);
		const got = await store.read();
		expect(Object.keys(got.tokens)).toHaveLength(25);
	});
});
