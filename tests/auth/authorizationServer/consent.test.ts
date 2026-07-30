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
} from '../../../src/auth/authorizationServer/consent.ts';
import { signConsent } from '../../../src/auth/authorizationServer/jwt.ts';

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
		expect(html).toContain('to use your');
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

	it('asks in the heading and keeps the document title free of client-supplied text', () => {
		const html = renderConsentPage({
			clientName: 'Totally Legit Bank Login',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: '127.0.0.1',
		});
		// The ask is the heading, so the largest text on a decision page is the
		// decision rather than a label.
		expect(html).toContain(
			'<h1 class="pg-title">Allow Totally Legit Bank Login to use your Example Wiki account?</h1>',
		);
		// The browser tab stays ours: a client that picked a misleading name must
		// not get to choose what the window says.
		expect(html).toContain('<title>Authorize application</title>');
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

	it('shows the loopback host and asks the one check a reader can run', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: '127.0.0.1',
		});
		// The host has to be visible: this is the loopback case the display
		// requirement exists for.
		expect(html).toContain('127.0.0.1');
		expect(html).toContain('on this device');
		// The timing check is the discriminator for the confused-deputy case, where
		// the user followed a link and started nothing.
		expect(html).toContain('Allow only if you started this sign-in a moment ago');
	});

	it('drops the address rather than rendering a dangling clause when no host is known', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: '',
		});
		// Unreachable through planAuthorize, which refuses an unregistered
		// redirect_uri before consent renders; the renderer must still not emit a
		// dangling comma.
		expect(html).toContain('an address on this device');
		expect(html).not.toContain('to  on this device');
	});

	it('does not caution for a remote destination', () => {
		const html = renderConsentPage({
			clientName: 'ChatGPT',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: 'chatgpt.com',
		});
		expect(html).not.toContain('Allow only if you started this sign-in');
	});

	it('promises no permissions step, which the wiki does not always show', () => {
		const html = renderConsentPage({
			clientName: 'Claude Code',
			wiki: 'Example Wiki',
			authorizeQuery: 'a=1',
			csrfToken: 't',
			redirectHost: '127.0.0.1',
		});
		// MediaWiki itemises grants the first time and remembers them after, which
		// is the same skip the confused-deputy mitigation exists for. Telling the
		// user a confirmation step follows would be false on every later sign-in.
		expect(html).not.toContain('next step');
	});

	it('makes no publisher claim, for any client shape', () => {
		for (const redirectHost of ['chatgpt.com', 'app.example.com', '127.0.0.1']) {
			const html = renderConsentPage({
				clientName: 'Some App',
				wiki: 'My Wiki',
				authorizeQuery: 'a=1',
				csrfToken: 't',
				redirectHost,
			});
			// What a metadata document proves is that a host on our allowlist served
			// these details — a fact about the allowlist, not one the reader can act
			// on. The return host is the fact that matters, and it is already shown.
			expect(html).toContain(redirectHost);
			expect(html).not.toContain('published');
			expect(html).not.toContain('Verified');
		}
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
