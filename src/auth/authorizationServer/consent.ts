import type { ProxyConfig } from './proxyConfig.js';
import { signConsent } from './jwt.js';
import { isLoopbackHost } from './redirectPolicy.js';
import { esc, renderPage } from '../pageShell.js';

const COOKIE = 'mcp_consent';
const CSRF_COOKIE = 'mcp_consent_csrf';
// Long enough for a human to read the consent page, short enough to bound the
// window in which the anti-CSRF nonce is valid.
const CSRF_TTL_SECONDS = 10 * 60;

export function renderConsentPage(a: {
	clientName: string;
	wiki: string;
	authorizeQuery: string;
	csrfToken: string;
	redirectHost: string;
	clientIdHost?: string;
}): string {
	// No per-permission line: the proxy always requests the consumer's full grants
	// (see authorize.ts). The user sees the exact grants on MediaWiki's own
	// authorization screen during the upstream leg.
	const destination =
		a.redirectHost && !isLoopbackHost(a.redirectHost)
			? a.redirectHost
			: 'an application on this device';
	// CIMD clients carry a verified client_id host (the client_id URL's host was
	// checked against the trusted allowlist and confirmed by the document's own
	// self-reference); the client_name below is self-asserted and unverified, so
	// the verified host leads. DCR clients pass no host and this line is omitted.
	const verifiedHost = a.clientIdHost
		? `<p class="pg-verified">Verified application: <strong>${esc(a.clientIdHost)}</strong></p>`
		: '';
	const body =
		verifiedHost +
		`<p class="pg-lead"><strong>${esc(a.clientName)}</strong> wants to act as you on <strong>${esc(a.wiki)}</strong>.</p>` +
		`<p class="pg-note">After you approve, you will be sent back to <strong>${esc(destination)}</strong>.</p>` +
		`<form method="POST" action="/mcp/consent?${esc(a.authorizeQuery)}" class="pg-actions">` +
		`<input type="hidden" name="csrf" value="${esc(a.csrfToken)}">` +
		`<button class="pg-btn pg-primary" name="decision" value="approve" type="submit">Approve</button>` +
		`<button class="pg-btn pg-neutral" name="decision" value="deny" type="submit">Deny</button>` +
		`</form>` +
		`<p class="pg-note">You'll confirm the exact permissions on ${esc(a.wiki)} in the next step.</p>`;
	return renderPage({ title: 'Authorize application', icon: { name: 'lock' }, body });
}

// Shown when the user denies and there is no trusted client redirect to bounce to.
export function renderCancelledPage(a: { clientName?: string }): string {
	const who = a.clientName ? `<strong>${esc(a.clientName)}</strong>` : 'the application';
	const body =
		`<p class="pg-lead">You declined to authorize ${who}. Nothing was shared with it.</p>` +
		`<p class="pg-note">You can close this window.</p>`;
	return renderPage({
		title: 'Authorization cancelled',
		icon: { name: 'cancel', accent: 'subtle' },
		body,
	});
}

// Shown on a terminal authorization error reached in the browser (e.g. a failed
// upstream exchange, a bad /authorize request, or a consent failure). `reason` is
// the already-sanitized error_description.
export function renderAuthErrorPage(a: { reason: string }): string {
	const body =
		`<p class="pg-lead">Something went wrong while authorizing the application. You can close this window and try connecting again.</p>` +
		`<p class="pg-mono">${esc(a.reason)}</p>`;
	return renderPage({
		title: 'Authorization failed',
		icon: { name: 'error', accent: 'error' },
		body,
	});
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
