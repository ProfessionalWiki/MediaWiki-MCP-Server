import { describe, it, expect } from 'vitest';
import { classifyAuthShape, hasStaticCredentials } from '../../src/runtime/authShape.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

function wiki(overrides: Partial<WikiConfig> = {}): WikiConfig {
	return {
		sitename: 'Example',
		server: 'https://example.org',
		articlepath: '/wiki',
		scriptpath: '/w',
		...overrides,
	};
}

describe('hasStaticCredentials', () => {
	it('is false for a wiki with no credential fields', () => {
		expect(hasStaticCredentials(wiki())).toBe(false);
	});

	it.each([null, ''])('is false when token is %p', (value) => {
		expect(hasStaticCredentials(wiki({ token: value }))).toBe(false);
	});

	it('is true when token is a non-empty string', () => {
		expect(hasStaticCredentials(wiki({ token: 'abc' }))).toBe(true);
	});

	it('is true when both username and password are non-empty strings', () => {
		expect(hasStaticCredentials(wiki({ username: 'u', password: 'p' }))).toBe(true);
	});

	it('is false when only username is set', () => {
		expect(hasStaticCredentials(wiki({ username: 'u' }))).toBe(false);
	});

	it('is false when only password is set', () => {
		expect(hasStaticCredentials(wiki({ password: 'p' }))).toBe(false);
	});

	it('is false when username or password is empty string', () => {
		expect(hasStaticCredentials(wiki({ username: '', password: 'p' }))).toBe(false);
		expect(hasStaticCredentials(wiki({ username: 'u', password: '' }))).toBe(false);
	});

	it('is true when token and bot-password fields are all set', () => {
		expect(hasStaticCredentials(wiki({ token: 't', username: 'u', password: 'p' }))).toBe(true);
	});

	it('is true when token is an ExecSecret object', () => {
		const execToken = { exec: { command: 'op', args: ['read', 'x'] } };
		expect(hasStaticCredentials(wiki({ token: execToken }))).toBe(true);
	});

	it('is true when username and password are both ExecSecret objects', () => {
		const execUser = { exec: { command: 'op', args: ['read', 'user'] } };
		const execPass = { exec: { command: 'op', args: ['read', 'pass'] } };
		expect(hasStaticCredentials(wiki({ username: execUser, password: execPass }))).toBe(true);
	});
});

describe('classifyAuthShape', () => {
	const baseWiki: WikiConfig = {
		sitename: 'X',
		server: 'https://x',
		articlepath: '/wiki',
		scriptpath: '/w',
	};

	it('returns static-credential when any wiki has a token', () => {
		const wikis = { a: { ...baseWiki, token: 't' } };
		expect(classifyAuthShape(wikis, 'http')).toBe('static-credential');
		expect(classifyAuthShape(wikis, 'stdio')).toBe('static-credential');
	});

	it('returns static-credential when any wiki has username and password', () => {
		const wikis = { a: { ...baseWiki, username: 'u', password: 'p' } };
		expect(classifyAuthShape(wikis, 'http')).toBe('static-credential');
	});

	it('returns bearer-passthrough on http when no static creds', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, 'http')).toBe('bearer-passthrough');
	});

	it('returns anonymous on stdio when no static creds', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, 'stdio')).toBe('anonymous');
	});

	it('returns oauth-proxy on http when the hosted proxy is enabled', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, 'http', true)).toBe('oauth-proxy');
	});

	it('static credentials take precedence over the proxy flag', () => {
		const wikis = { a: { ...baseWiki, token: 't' } };
		expect(classifyAuthShape(wikis, 'http', true)).toBe('static-credential');
	});

	it('proxy flag is ignored on stdio', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, 'stdio', true)).toBe('anonymous');
	});

	it('is unaffected by partial credentials (username only or password only)', () => {
		const wikisU = { a: { ...baseWiki, username: 'u' } };
		const wikisP = { a: { ...baseWiki, password: 'p' } };
		expect(classifyAuthShape(wikisU, 'http')).toBe('bearer-passthrough');
		expect(classifyAuthShape(wikisP, 'http')).toBe('bearer-passthrough');
	});
});
