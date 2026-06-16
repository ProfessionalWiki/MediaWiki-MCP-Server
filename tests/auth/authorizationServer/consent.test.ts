import { describe, it, expect } from 'vitest';
import {
	renderConsentPage,
	buildConsentCookie,
	readConsentCookie,
} from '../../../src/auth/authorizationServer/consent.js';
import { signConsent } from '../../../src/auth/authorizationServer/jwt.js';

const pc = {
	issuer: 'https://wiki.example/mcp',
	consentTtlMs: 60_000,
	signingKey: 'k'.repeat(32),
} as any;

describe('consent', () => {
	it('renders the client name and scopes', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example',
			scopes: ['editpage'],
			authorizeQuery: 'txn=1',
		});
		expect(html).toContain('Claude Code');
		expect(html).toContain('editpage');
		expect(html).toContain('txn=1');
	});
	it('escapes HTML in the client name', () => {
		const html = renderConsentPage({
			clientName: '<script>x</script>',
			wiki: 'W',
			scopes: [],
			authorizeQuery: 'txn=1',
		});
		expect(html).not.toContain('<script>x</script>');
		expect(html).toContain('&lt;script&gt;');
	});
	it('builds a scoped Set-Cookie', async () => {
		const cookie = await buildConsentCookie(pc, {
			clientId: 'cid',
			redirectHost: '127.0.0.1',
			wiki: 'w',
		});
		expect(cookie).toMatch(/^mcp_consent=/);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Path=/mcp');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Secure');
	});
	it('reads back the cookie value', async () => {
		const value = await signConsent({
			clientId: 'cid',
			redirectHost: '127.0.0.1',
			wiki: 'w',
			ttlMs: 60_000,
			signingKey: pc.signingKey,
		});
		expect(readConsentCookie(`other=1; mcp_consent=${value}; x=2`)).toBe(value);
		expect(readConsentCookie(undefined)).toBeUndefined();
	});
});
