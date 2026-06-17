const CLAUDE_AI_CALLBACK = 'https://claude.ai/api/mcp/auth_callback';

export function isAllowedRedirect(redirectUri: string): boolean {
	let u: URL;
	try {
		u = new URL(redirectUri);
	} catch {
		return false;
	}

	if (u.protocol === 'http:' && (u.hostname === '127.0.0.1' || u.hostname === 'localhost')) {
		return true; // RFC 8252 loopback, any port
	}
	if (u.protocol === 'https:' && `${u.origin}${u.pathname}` === CLAUDE_AI_CALLBACK) {
		return true;
	}
	return false;
}
