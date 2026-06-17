import { describe, it, expect } from 'vitest';
import {
	renderConsentPage,
	buildConsentCookie,
	readConsentCookie,
	buildCsrfCookie,
	readCsrfCookie,
	buildTxnCookie,
	readTxnCookie,
} from '../../../src/auth/authorizationServer/consent.js';
import { signConsent } from '../../../src/auth/authorizationServer/jwt.js';

const pc = {
	issuer: 'https://wiki.example/mcp',
	consentTtlMs: 60_000,
	signingKey: 'k'.repeat(32),
} as any;

describe('consent', () => {
	it('renders the client name and the act-as-you line, with no permissions list', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example',
			authorizeQuery: 'txn=1',
			csrfToken: 'nonce-abc',
		});
		expect(html).toContain('Claude Code');
		expect(html).toContain('act as you on');
		expect(html).toContain('Example');
		expect(html).toContain('txn=1');
		expect(html).not.toContain('Permissions:');
	});
	it('embeds the CSRF token as a hidden form field', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example',
			authorizeQuery: 'txn=1',
			csrfToken: 'nonce-abc',
		});
		expect(html).toContain('name="csrf"');
		expect(html).toContain('value="nonce-abc"');
	});
	it('escapes HTML in the client name', () => {
		const html = renderConsentPage({
			clientName: '<script>x</script>',
			wiki: 'W',
			authorizeQuery: 'txn=1',
			csrfToken: 'nonce-abc',
		});
		expect(html).not.toContain('<script>x</script>');
		expect(html).toContain('&lt;script&gt;');
	});
	it('builds a SameSite=Strict, HttpOnly CSRF cookie and reads it back', () => {
		const cookie = buildCsrfCookie('nonce-xyz');
		expect(cookie).toMatch(/^mcp_consent_csrf=nonce-xyz/);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Strict');
		expect(cookie).toContain('Path=/mcp');
		expect(readCsrfCookie('a=1; mcp_consent_csrf=nonce-xyz; b=2')).toBe('nonce-xyz');
		expect(readCsrfCookie(undefined)).toBeUndefined();
	});
	it('builds and reads the txn cookie (SameSite=Lax fallback for the callback)', () => {
		const cookie = buildTxnCookie('txn-123');
		expect(cookie).toMatch(/^mcp_txn=txn-123/);
		expect(cookie).toContain('HttpOnly');
		expect(cookie).toContain('Secure');
		expect(cookie).toContain('SameSite=Lax');
		expect(cookie).toContain('Path=/mcp');
		expect(readTxnCookie('a=1; mcp_txn=txn-123; b=2')).toBe('txn-123');
		expect(readTxnCookie(undefined)).toBeUndefined();
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
