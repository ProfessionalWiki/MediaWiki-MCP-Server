import { describe, it, expect, vi } from 'vitest';
import {
	isCimdClientId,
	validateClientIdUrl,
	CimdValidationError,
	SHIPPED_CIMD_HOSTS,
	parseCimdAllowedHosts,
	buildCimdHostPredicate,
	validateCimdDocument,
	synthesizeClientRecord,
	cimdTtlMs,
	CimdResolver,
} from '../../../src/auth/authorizationServer/cimd.js';

describe('isCimdClientId', () => {
	it.each([
		['https://vscode.dev/oauth/client-metadata.json', true],
		['https://chatgpt.com/oauth/x/client.json?connector=1', true],
		['mcp-3f2b1a00-0000-4000-8000-000000000000', false],
		['http://127.0.0.1/callback', false],
		['not a url', false],
	])('%s -> %s', (id, ok) => expect(isCimdClientId(id as string)).toBe(ok));
});

describe('validateClientIdUrl', () => {
	it('accepts https with a path, query and root path allowed', () => {
		expect(validateClientIdUrl('https://vscode.dev/oauth/client-metadata.json').host).toBe(
			'vscode.dev',
		);
		expect(() => validateClientIdUrl('https://chatgpt.com/oauth/x/client.json?c=1')).not.toThrow();
		expect(() => validateClientIdUrl('https://vendor.example/')).not.toThrow();
	});
	it.each([
		['http://vscode.dev/x'],
		['https://user:pw@vscode.dev/x'],
		['https://vscode.dev/x#frag'],
		['https://vscode.dev/a/../b'],
		['https://vscode.dev/foo/..'],
		['https://vscode.dev/foo/./bar'],
		['https://vscode.dev/a\\..\\b'],
	])('rejects %s', (u) =>
		expect(() => validateClientIdUrl(u as string)).toThrow(CimdValidationError),
	);
	it('accepts a query value that contains a slash-dot substring', () => {
		expect(() => validateClientIdUrl('https://vscode.dev/callback?returnTo=/a/../b')).not.toThrow();
	});
	it('sets the error name', () => {
		expect(new CimdValidationError('x').name).toBe('CimdValidationError');
	});
});

describe('CIMD host allowlist', () => {
	it('ships the four first-party hosts', () => {
		expect([...SHIPPED_CIMD_HOSTS].sort()).toEqual([
			'chatgpt.com',
			'claude.ai',
			'vscode.dev',
			'zed.dev',
		]);
	});
	it('accepts shipped hosts case-folded, rejects others', () => {
		const p = buildCimdHostPredicate([]);
		expect(p('vscode.dev')).toBe(true);
		expect(p('ZED.DEV')).toBe(true);
		expect(p('evil.example')).toBe(false);
	});
	it('extends with operator hosts', () => {
		const p = buildCimdHostPredicate(parseCimdAllowedHosts('my.wiki, cimd.example:8443'));
		expect(p('my.wiki')).toBe(true);
		expect(p('cimd.example:8443')).toBe(true);
	});
	it('rejects a malformed operator entry', () => {
		expect(() => parseCimdAllowedHosts('has space')).toThrow(/CIMD|host/i);
	});
	it.each([['*.vscode.dev'], ['http://vscode.dev'], ['vscode.dev/evil']])(
		'rejects malformed entry %s',
		(e) => expect(() => parseCimdAllowedHosts(e as string)).toThrow(CimdValidationError),
	);
});

const URL_ID = 'https://vscode.dev/oauth/client-metadata.json';
const goodDoc = {
	client_id: URL_ID,
	client_name: 'VS Code',
	redirect_uris: ['https://vscode.dev/redirect', 'http://127.0.0.1/callback'],
};

describe('validateCimdDocument', () => {
	it('accepts a well-formed document', () => {
		expect(validateCimdDocument(URL_ID, goodDoc).client_name).toBe('VS Code');
	});
	it('ignores token_endpoint_auth_method (tolerant of private_key_jwt)', () => {
		expect(() =>
			validateCimdDocument(URL_ID, { ...goodDoc, token_endpoint_auth_method: 'private_key_jwt' }),
		).not.toThrow();
	});
	it.each([
		[{ ...goodDoc, client_id: 'https://vscode.dev:443/oauth/client-metadata.json' }],
		[{ ...goodDoc, client_id: 'https://evil.example/x' }],
		[{ ...goodDoc, client_name: '' }],
		[{ ...goodDoc, redirect_uris: [] }],
		[{ ...goodDoc, redirect_uris: 'https://vscode.dev/redirect' }],
		['not an object'],
		[null],
		[[]],
		[{ ...goodDoc, redirect_uris: [123] }],
		[{ ...goodDoc, client_name: '   ' }],
	])('rejects %#', (doc) =>
		expect(() => validateCimdDocument(URL_ID, doc)).toThrow(CimdValidationError),
	);

	it.each([
		['http://evil.example/cb'], // cleartext http, non-loopback
		['HTTP://EVIL.EXAMPLE/cb'], // scheme/host are case-folded before the check
		['http://user@evil.example/cb'], // userinfo does not change the host
		['http://127.0.0.1.evil.example/cb'], // deceptive: starts with a loopback literal but is NOT loopback
		['//evil.example/cb'], // protocol-relative: not a parseable absolute URL
		['not-a-url'], // unparseable
		[''], // empty
	])('rejects a disallowed redirect %s', (uri) => {
		expect(() => validateCimdDocument(URL_ID, { ...goodDoc, redirect_uris: [uri] })).toThrow(
			CimdValidationError,
		);
	});

	it('rejects when ANY redirect_uri is disallowed', () => {
		expect(() =>
			validateCimdDocument(URL_ID, {
				...goodDoc,
				redirect_uris: ['https://vscode.dev/redirect', 'http://evil.example/cb'],
			}),
		).toThrow(CimdValidationError);
	});

	it.each([
		['https://vscode.dev/redirect'],
		['https://app.example.com:8443/cb'],
		['http://127.0.0.1:8080/cb'],
		['http://localhost/cb'],
		['http://[::1]:1234/cb'],
		['vscode://vscode.dev/callback'],
		['com.example.app:/oauth2redirect'], // RFC 8252 private-use scheme
	])('accepts %s (https, loopback http, or custom scheme)', (uri) => {
		expect(() => validateCimdDocument(URL_ID, { ...goodDoc, redirect_uris: [uri] })).not.toThrow();
	});
});

describe('synthesizeClientRecord', () => {
	it('maps a document to a public ClientRecord', () => {
		const rec = synthesizeClientRecord(URL_ID, validateCimdDocument(URL_ID, goodDoc));
		expect(rec).toMatchObject({
			clientId: URL_ID,
			name: 'VS Code',
			scopes: [],
			redirectUris: goodDoc.redirect_uris,
		});
	});
});

describe('cimdTtlMs', () => {
	it.each([
		['max-age=3600', 3600_000],
		['max-age=10', 300_000],
		['max-age=999999', 86400_000],
		[null, 3600_000],
		['no-store', 3600_000],
	])('%s -> %s', (cc, ms) => expect(cimdTtlMs(cc as string | null)).toBe(ms));
});

describe('CimdResolver', () => {
	const URL_ID = 'https://vscode.dev/oauth/client-metadata.json';
	const doc = JSON.stringify({
		client_id: URL_ID,
		client_name: 'VS Code',
		redirect_uris: ['https://vscode.dev/redirect'],
	});
	const allow = (h: string) => h === 'vscode.dev';

	it('resolves an allowlisted host with a valid document', async () => {
		const fetcher = vi.fn(async () => ({ status: 200, body: doc, cacheControl: 'max-age=3600' }));
		const r = await new CimdResolver(allow, fetcher).resolve(URL_ID);
		expect(r.ok && r.client.name).toBe('VS Code');
	});
	it('rejects an untrusted host without fetching', async () => {
		const fetcher = vi.fn();
		const r = await new CimdResolver(allow, fetcher).resolve('https://evil.example/c.json');
		expect(r.ok).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('rejects a non-200 status and does not cache it', async () => {
		const fetcher = vi.fn(async () => ({ status: 404, body: '', cacheControl: null }));
		const resolver = new CimdResolver(allow, fetcher);
		expect((await resolver.resolve(URL_ID)).ok).toBe(false);
		await resolver.resolve(URL_ID);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('caches a success within the TTL', async () => {
		let t = 0;
		const fetcher = vi.fn(async () => ({ status: 200, body: doc, cacheControl: 'max-age=3600' }));
		const resolver = new CimdResolver(allow, fetcher, () => t);
		await resolver.resolve(URL_ID);
		t = 60_000;
		await resolver.resolve(URL_ID);
		expect(fetcher).toHaveBeenCalledTimes(1);
	});
	it('rejects a malformed client_id without fetching', async () => {
		const fetcher = vi.fn();
		const r = await new CimdResolver(allow, fetcher).resolve('not-a-url');
		expect(r.ok).toBe(false);
		expect(fetcher).not.toHaveBeenCalled();
	});
	it('rejects unparseable JSON and does not cache it', async () => {
		const fetcher = vi.fn(async () => ({ status: 200, body: 'not json', cacheControl: null }));
		const resolver = new CimdResolver(allow, fetcher);
		expect((await resolver.resolve(URL_ID)).ok).toBe(false);
		await resolver.resolve(URL_ID);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('rejects a document that fails validation and does not cache it', async () => {
		const bad = JSON.stringify({
			client_id: URL_ID,
			client_name: '',
			redirect_uris: ['https://vscode.dev/redirect'],
		});
		const fetcher = vi.fn(async () => ({ status: 200, body: bad, cacheControl: null }));
		const resolver = new CimdResolver(allow, fetcher);
		expect((await resolver.resolve(URL_ID)).ok).toBe(false);
		await resolver.resolve(URL_ID);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
	it('surfaces a fetcher throw as the reason', async () => {
		const fetcher = vi.fn(async () => {
			throw new Error('boom');
		});
		const r = await new CimdResolver(allow, fetcher).resolve(URL_ID);
		expect(!r.ok && r.reason).toBe('boom');
	});
	it('refetches after the TTL expires', async () => {
		let t = 0;
		const fetcher = vi.fn(async () => ({ status: 200, body: doc, cacheControl: 'max-age=3600' }));
		const resolver = new CimdResolver(allow, fetcher, () => t);
		await resolver.resolve(URL_ID);
		t = 3600_000 + 1;
		await resolver.resolve(URL_ID);
		expect(fetcher).toHaveBeenCalledTimes(2);
	});
});
