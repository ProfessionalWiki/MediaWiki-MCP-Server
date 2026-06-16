import type { ProxyConfig } from './proxyConfig.js';
import { signConsent } from './jwt.js';

const COOKIE = 'mcp_consent';

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
}): string {
	const scopes = a.scopes.length ? a.scopes.map(esc).join(', ') : 'basic access';
	return `<!doctype html><meta charset="utf-8"><title>Authorize</title>
<body style="font-family:system-ui;max-width:32rem;margin:4rem auto">
<h1>Authorize application</h1>
<p><strong>${esc(a.clientName)}</strong> wants to act as you on <strong>${esc(a.wiki)}</strong>.</p>
<p>Permissions: ${scopes}.</p>
<form method="POST" action="/mcp/consent?${esc(a.authorizeQuery)}">
  <button name="decision" value="approve" type="submit">Approve</button>
  <button name="decision" value="deny" type="submit">Deny</button>
</form></body>`;
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
	if (!cookieHeader) {
		return undefined;
	}
	for (const part of cookieHeader.split(';')) {
		const [k, ...v] = part.trim().split('=');
		if (k === COOKIE) {
			return v.join('=');
		}
	}
	return undefined;
}
