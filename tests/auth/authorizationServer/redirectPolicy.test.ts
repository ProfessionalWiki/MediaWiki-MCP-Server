import { describe, it, expect } from 'vitest';
import {
	isAllowedRedirect,
	parseRedirectAllowlist,
	buildRedirectPolicy,
	RedirectAllowlistError,
	redirectUriMatches,
} from '../../../src/auth/authorizationServer/redirectPolicy.js';

describe('isAllowedRedirect', () => {
	it.each([
		['http://127.0.0.1:9000/callback', true],
		['http://localhost:51234/oauth/callback', true],
		['http://[::1]:9000/cb', true],
		['https://claude.ai/api/mcp/auth_callback', true],
	])('allows %s', (u, ok) => expect(isAllowedRedirect(u as string)).toBe(ok));

	it.each([
		['http://evil.example/cb'],
		['https://claude.ai/evil'],
		['https://127.0.0.1:9000/callback'],
		['http://10.0.0.5:9000/cb'],
		['not-a-url'],
	])('rejects %s', (u) => expect(isAllowedRedirect(u as string)).toBe(false));
});

describe('parseRedirectAllowlist', () => {
	it('returns an empty list when unset', () => {
		expect(parseRedirectAllowlist(undefined)).toEqual([]);
	});

	it('parses exact and pattern entries, trimming and skipping blanks', () => {
		expect(
			parseRedirectAllowlist(
				' https://vscode.dev/redirect ,, https://chatgpt.com/connector/oauth/* ',
			),
		).toEqual([
			{ kind: 'exact', uri: 'https://vscode.dev/redirect' },
			{ kind: 'prefix', origin: 'https://chatgpt.com', pathPrefix: '/connector/oauth/' },
		]);
	});

	it('parses custom-scheme exact entries', () => {
		expect(parseRedirectAllowlist('cursor://anysphere.cursor-mcp/oauth/callback')).toEqual([
			{ kind: 'exact', uri: 'cursor://anysphere.cursor-mcp/oauth/callback' },
		]);
	});

	it.each([
		['bare star', '*'],
		['star combined with entries', '*,https://vscode.dev/redirect'],
		['http pattern', 'http://chatgpt.com/connector/oauth/*'],
		['mid-path wildcard', 'https://chatgpt.com/*/callback'],
		['bare host', 'vscode.dev'],
		['pattern with query', 'https://chatgpt.com/cb?x=1/*'],
		['pattern with userinfo', 'https://user@chatgpt.com/oauth/*'],
		['host-less custom scheme', 'com.example.app:/oauth2redirect'],
	])('rejects %s', (_name, raw) => {
		expect(() => parseRedirectAllowlist(raw)).toThrow(RedirectAllowlistError);
	});
});

describe('buildRedirectPolicy', () => {
	const policy = buildRedirectPolicy(
		parseRedirectAllowlist(
			'https://vscode.dev/redirect,cursor://anysphere.cursor-mcp/oauth/callback,https://chatgpt.com/connector/oauth/*',
		),
	);

	it.each([
		['built-in loopback', 'http://127.0.0.1:9000/cb', true],
		['built-in IPv6 loopback', 'http://[::1]:9000/cb', true],
		['built-in claude.ai', 'https://claude.ai/api/mcp/auth_callback', true],
		['exact entry', 'https://vscode.dev/redirect', true],
		['exact near-miss (trailing slash)', 'https://vscode.dev/redirect/', false],
		['custom-scheme exact entry', 'cursor://anysphere.cursor-mcp/oauth/callback', true],
		['pattern match', 'https://chatgpt.com/connector/oauth/abc123', true],
		['pattern origin mismatch', 'https://evil.example/connector/oauth/abc', false],
		['pattern scheme mismatch', 'http://chatgpt.com/connector/oauth/abc', false],
		['pattern path traversal', 'https://chatgpt.com/connector/oauth/../../evil', false],
		['pattern with fragment', 'https://chatgpt.com/connector/oauth/abc#f', false],
		['pattern segment boundary', 'https://chatgpt.com/connector/oauthEVIL/x', false],
		['pattern base without trailing slash', 'https://chatgpt.com/connector/oauth', false],
		['https loopback still rejected', 'https://127.0.0.1:9443/cb', false],
		['unlisted https URI', 'https://example.com/cb', false],
	])('policy: %s → %s', (_name, uri, expected) => {
		expect(policy(uri)).toBe(expected);
	});
});

describe('redirectUriMatches', () => {
	it('matches identical URIs', () => {
		expect(redirectUriMatches('https://vscode.dev/redirect', 'https://vscode.dev/redirect')).toBe(
			true,
		);
	});
	it('matches http loopback differing only in port', () => {
		expect(redirectUriMatches('http://127.0.0.1:3118/callback', 'http://127.0.0.1/callback')).toBe(
			true,
		);
		expect(redirectUriMatches('http://127.0.0.1:27523/cb', 'http://127.0.0.1:5000/cb')).toBe(true);
	});
	it('rejects loopback when path/query/fragment differ', () => {
		expect(redirectUriMatches('http://127.0.0.1:3118/evil', 'http://127.0.0.1/callback')).toBe(
			false,
		);
		expect(redirectUriMatches('http://127.0.0.1:3118/cb?x=1', 'http://127.0.0.1/cb')).toBe(false);
	});
	it('rejects when the loopback host literal differs (127.0.0.1 vs localhost)', () => {
		expect(redirectUriMatches('http://127.0.0.1:3118/cb', 'http://localhost/cb')).toBe(false);
	});
	it('does not port-relax non-loopback or https', () => {
		expect(
			redirectUriMatches('https://vscode.dev:8443/redirect', 'https://vscode.dev/redirect'),
		).toBe(false);
		expect(redirectUriMatches('http://evil.example:9/cb', 'http://evil.example/cb')).toBe(false);
	});
	it('matches IPv6 loopback differing only in port', () => {
		expect(redirectUriMatches('http://[::1]:9000/cb', 'http://[::1]/cb')).toBe(true);
	});
	it('does not cross-match IPv6 loopback with IPv4 loopback', () => {
		expect(redirectUriMatches('http://[::1]:9000/cb', 'http://127.0.0.1/cb')).toBe(false);
	});
	it('rejects when the fragment differs', () => {
		expect(redirectUriMatches('http://127.0.0.1:3118/cb#a', 'http://127.0.0.1/cb#b')).toBe(false);
	});
	it('rejects when userinfo differs', () => {
		expect(redirectUriMatches('http://evil@127.0.0.1:9000/cb', 'http://127.0.0.1/cb')).toBe(false);
	});
});
