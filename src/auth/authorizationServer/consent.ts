import type { ProxyConfig } from './proxyConfig.js';
import { signConsent } from './jwt.js';

const COOKIE = 'mcp_consent';
const CSRF_COOKIE = 'mcp_consent_csrf';
// Long enough for a human to read the consent page, short enough to bound the
// window in which the anti-CSRF nonce is valid.
const CSRF_TTL_SECONDS = 10 * 60;

function esc(s: string): string {
	return s.replace(
		/[&<>"']/g,
		(c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!,
	);
}

export function renderConsentPage(a: {
	clientName: string;
	wiki: string;
	scopes: string[];
	authorizeQuery: string;
	csrfToken: string;
}): string {
	const scopes = a.scopes.length ? a.scopes.map(esc).join(', ') : 'basic access';
	return `<!doctype html><meta charset="utf-8"><title>Authorize</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>Authorize application</h1>
<p><strong>${esc(a.clientName)}</strong> wants to act as you on <strong>${esc(a.wiki)}</strong>.</p>
<p>Permissions: ${scopes}.</p>
<form method="POST" action="/mcp/consent?${esc(a.authorizeQuery)}">
  <input type="hidden" name="csrf" value="${esc(a.csrfToken)}">
  <button name="decision" value="approve" type="submit">Approve</button>
  <button name="decision" value="deny" type="submit">Deny</button>
</form></body>`;
}

// Anti-CSRF nonce for the consent decision. SameSite=Strict so a cross-site POST
// cannot carry it, HttpOnly so script cannot read it: the form must echo this
// value (double-submit) for an approval to be honoured.
export function buildCsrfCookie(token: string): string {
	return `${CSRF_COOKIE}=${token}; HttpOnly; Secure; SameSite=Strict; Path=/mcp; Max-Age=${CSRF_TTL_SECONDS}`;
}

export function readCsrfCookie(cookieHeader: string | undefined): string | undefined {
	return readCookie(cookieHeader, CSRF_COOKIE);
}

const TXN_COOKIE = 'mcp_txn';
// Matches the transaction TTL (proxyStore TXN_TTL_MS); the cookie is only a
// fallback for recovering the txn id on the callback.
const TXN_COOKIE_TTL_SECONDS = 15 * 60;

// Scoped to the callback path only — the single endpoint that consumes it — to
// minimise its blast radius.
const TXN_COOKIE_PATH = '/mcp/oauth/callback';

// Carries the proxy transaction id across the upstream-wiki round-trip. MediaWiki's
// Extension:OAuth drops the `state` parameter on a denial (and uses a non-standard
// error code), so the callback cannot otherwise map a denial back to its client.
// SameSite=Lax so it survives the top-level GET navigation back from the wiki.
export function buildTxnCookie(txnId: string): string {
	return `${TXN_COOKIE}=${txnId}; HttpOnly; Secure; SameSite=Lax; Path=${TXN_COOKIE_PATH}; Max-Age=${TXN_COOKIE_TTL_SECONDS}`;
}

// Expires the txn cookie after the callback consumes it, so it can't linger and be
// matched to an unrelated later flow.
export function clearTxnCookie(): string {
	return `${TXN_COOKIE}=; HttpOnly; Secure; SameSite=Lax; Path=${TXN_COOKIE_PATH}; Max-Age=0`;
}

export function readTxnCookie(cookieHeader: string | undefined): string | undefined {
	return readCookie(cookieHeader, TXN_COOKIE);
}

export async function buildConsentCookie(
	pc: ProxyConfig,
	b: { clientId: string; redirectHost: string; wiki: string },
): Promise<string> {
	const value = await signConsent({ ...b, ttlMs: pc.consentTtlMs, signingKey: pc.signingKey });
	const maxAge = Math.floor(pc.consentTtlMs / 1000);
	return `${COOKIE}=${value}; HttpOnly; Secure; SameSite=Lax; Path=/mcp; Max-Age=${maxAge}`;
}

export function readConsentCookie(cookieHeader: string | undefined): string | undefined {
	return readCookie(cookieHeader, COOKIE);
}

function readCookie(cookieHeader: string | undefined, name: string): string | undefined {
	if (!cookieHeader) {
		return undefined;
	}
	for (const part of cookieHeader.split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === name) {
			return v.join('=');
		}
	}
	return undefined;
}
