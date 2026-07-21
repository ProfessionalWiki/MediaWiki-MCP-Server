import { describe, it, expect } from 'vitest';
import {
	renderConsentPage,
	renderCancelledPage,
	renderAuthErrorPage,
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
	it('renders the consent page with client, wiki, the form and CSRF field', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example',
			authorizeQuery: 'txn=1',
			csrfToken: 'nonce-abc',
			redirectHost: 'chatgpt.com',
		});
		expect(html).toContain('Authorize application');
		expect(html).toContain('Claude Code');
		expect(html).toContain('act as you on');
		expect(html).toContain('Example');
		expect(html).toContain('action="/mcp/consent?txn=1"');
		expect(html).toContain('name="csrf"');
		expect(html).toContain('value="nonce-abc"');
		expect(html).toContain('value="approve"');
		expect(html).toContain('value="deny"');
		expect(html).not.toContain('Permissions:');
	});

	it('escapes HTML in the client name', () => {
		const html = renderConsentPage({
			clientName: '<script>x</script>',
			wiki: 'W',
			authorizeQuery: 'txn=1',
			csrfToken: 'n',
			redirectHost: 'chatgpt.com',
		});
		expect(html).not.toContain('<script>x</script>');
		expect(html).toContain('&lt;script&gt;');
	});

	it('shows the redirect destination host', () => {
		const html = renderConsentPage({
			clientName: 'ChatGPT',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: 'chatgpt.com',
		});
		expect(html).toContain('chatgpt.com');
	});

	it('renders loopback destinations as on-device', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: '127.0.0.1',
		});
		expect(html).toContain('an application on this device');
		expect(html).not.toContain('127.0.0.1');
	});

	it('shows the verified client_id host, leading the self-asserted name', () => {
		const html = renderConsentPage({
			clientName: 'VS Code',
			wiki: 'My Wiki',
			authorizeQuery: 'client_id=x',
			csrfToken: 't',
			redirectHost: 'vscode.dev',
			clientIdHost: 'code.visualstudio.com',
		});
		expect(html).toContain('code.visualstudio.com');
		expect(html).toContain('Verified application');
		expect(html.indexOf('pg-verified')).toBeLessThan(html.indexOf('pg-lead'));
	});

	it('renders cancelled and auth-error pages', () => {
		const cancelled = renderCancelledPage({ clientName: 'Claude Code' });
		expect(cancelled).toContain('Authorization cancelled');
		expect(cancelled).toContain('Claude Code');

		const err = renderAuthErrorPage({ reason: 'upstream token exchange failed' });
		expect(err).toContain('Authorization failed');
		expect(err).toContain('upstream token exchange failed');

		// cancelled page with no client name falls back to a generic phrase
		const cancelledNoName = renderCancelledPage({});
		expect(cancelledNoName).toContain('the application');

		// the auth-error reason is escaped (it can carry upstream error_description text)
		const errXss = renderAuthErrorPage({ reason: '<script>alert(1)</script>' });
		expect(errXss).not.toContain('<script>alert(1)</script>');
		expect(errXss).toContain('&lt;script&gt;');
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
