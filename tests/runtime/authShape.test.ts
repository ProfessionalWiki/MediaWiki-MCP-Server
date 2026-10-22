import { describe, it, expect } from 'vitest';
import {
	classifyAuthShape,
	hasStaticCredentials,
	readAuthPolicy,
	usesOAuthSignIn,
} from '../../src/runtime/authShape.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { fakeAuthPolicy } from '../helpers/fakeAuthPolicy.ts';
import { fakeHostedProxy } from '../helpers/fakeHostedProxy.ts';
import { fakeProxyConfig } from '../helpers/fakeProxyConfig.ts';

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

describe('usesOAuthSignIn', () => {
	it('is true for a wiki with an OAuth client id', () => {
		expect(usesOAuthSignIn(wiki({ oauth2ClientId: 'client' }))).toBe(true);
	});

	it('is false for a wiki without one', () => {
		expect(usesOAuthSignIn(wiki())).toBe(false);
		expect(usesOAuthSignIn(wiki({ oauth2ClientId: null }))).toBe(false);
	});

	it('is false for a blank client id', () => {
		expect(usesOAuthSignIn(wiki({ oauth2ClientId: '' }))).toBe(false);
		expect(usesOAuthSignIn(wiki({ oauth2ClientId: '  ' }))).toBe(false);
	});
});

describe('classifyAuthShape', () => {
	const PROXY = fakeHostedProxy(fakeProxyConfig(), new InMemoryProxyStore());
	const baseWiki: WikiConfig = {
		sitename: 'X',
		server: 'https://x',
		articlepath: '/wiki',
		scriptpath: '/w',
	};

	it('returns static-credential when any wiki has a token', () => {
		const wikis = { a: { ...baseWiki, token: 't' } };
		expect(classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http' }))).toBe(
			'static-credential',
		);
		expect(classifyAuthShape(wikis, fakeAuthPolicy())).toBe('static-credential');
	});

	it('returns static-credential when any wiki has username and password', () => {
		const wikis = { a: { ...baseWiki, username: 'u', password: 'p' } };
		expect(classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http' }))).toBe(
			'static-credential',
		);
	});

	it('returns anonymous on http when no static creds and passthrough is off', () => {
		const wikis = { a: baseWiki };
		// Forwarding a caller-supplied bearer is off unless opted into, so a plain
		// HTTP deployment is not a passthrough deployment by default.
		expect(classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http' }))).toBe('anonymous');
	});

	it('returns bearer-passthrough on http once forwarding is opted into', () => {
		const wikis = { a: baseWiki };
		expect(
			classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http', bearerPassthrough: true })),
		).toBe('bearer-passthrough');
	});

	it('returns anonymous on stdio when no static creds', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, fakeAuthPolicy())).toBe('anonymous');
	});

	it('returns oauth-proxy on http when the hosted proxy is enabled', () => {
		const wikis = { a: baseWiki };
		expect(
			classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http', hostedProxy: PROXY })),
		).toBe('oauth-proxy');
	});

	it('static credentials take precedence over the proxy flag', () => {
		const wikis = { a: { ...baseWiki, token: 't' } };
		expect(
			classifyAuthShape(wikis, fakeAuthPolicy({ transport: 'http', hostedProxy: PROXY })),
		).toBe('static-credential');
	});

	it('proxy flag is ignored on stdio', () => {
		const wikis = { a: baseWiki };
		expect(classifyAuthShape(wikis, fakeAuthPolicy({ hostedProxy: PROXY }))).toBe('anonymous');
	});

	it('is unaffected by partial credentials (username only or password only)', () => {
		const wikisU = { a: { ...baseWiki, username: 'u' } };
		const wikisP = { a: { ...baseWiki, password: 'p' } };
		expect(
			classifyAuthShape(wikisU, fakeAuthPolicy({ transport: 'http', bearerPassthrough: true })),
		).toBe('bearer-passthrough');
		expect(
			classifyAuthShape(wikisP, fakeAuthPolicy({ transport: 'http', bearerPassthrough: true })),
		).toBe('bearer-passthrough');
	});
});

describe('readAuthPolicy', () => {
	it('leaves forwarding and the static fallback off when their variables are unset', () => {
		expect(readAuthPolicy({}, 'stdio', null)).toMatchObject({
			bearerPassthrough: false,
			staticFallback: false,
		});
	});

	it('turns each on only for its own variable set to "true"', () => {
		expect(readAuthPolicy({ MCP_ALLOW_BEARER_PASSTHROUGH: 'true' }, 'stdio', null)).toMatchObject({
			bearerPassthrough: true,
			staticFallback: false,
		});
		expect(readAuthPolicy({ MCP_ALLOW_STATIC_FALLBACK: 'true' }, 'stdio', null)).toMatchObject({
			bearerPassthrough: false,
			staticFallback: true,
		});
	});

	it.each(['TRUE', '1', 'yes', ' true ', ''])('treats %p as off', (value) => {
		expect(
			readAuthPolicy(
				{ MCP_ALLOW_BEARER_PASSTHROUGH: value, MCP_ALLOW_STATIC_FALLBACK: value },
				'stdio',
				null,
			),
		).toMatchObject({ bearerPassthrough: false, staticFallback: false });
	});
});
