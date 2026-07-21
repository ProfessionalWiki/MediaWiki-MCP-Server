import { describe, it, expect } from 'vitest';
import {
	isCimdClientId,
	validateClientIdUrl,
	CimdValidationError,
	SHIPPED_CIMD_HOSTS,
	parseCimdAllowedHosts,
	buildCimdHostPredicate,
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
