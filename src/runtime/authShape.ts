import type { WikiConfig } from '../config/loadConfig.js';
import { isCredentialConfigured } from '../config/loadConfig.js';

// Pure classification of how the server authenticates to its wikis, derived from
// config alone. A lower-layer primitive: consumed by runtime/ (banner, wiki
// capability) and transport/ (the startup bearer guard, streamableHttp) alike, so
// it lives here rather than in transport to keep those callers pointing down.

export function hasStaticCredentials(wiki: WikiConfig): boolean {
	if (isCredentialConfigured(wiki.token)) {
		return true;
	}
	return isCredentialConfigured(wiki.username) && isCredentialConfigured(wiki.password);
}

export type AuthShape = 'anonymous' | 'static-credential' | 'bearer-passthrough' | 'oauth-proxy';
export type Transport = 'stdio' | 'http';

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	transport: Transport,
	proxyEnabled = false,
): AuthShape {
	const anyStatic = Object.values(wikis).some(hasStaticCredentials);
	if (anyStatic) {
		return 'static-credential';
	}
	if (transport !== 'http') {
		return 'anonymous';
	}
	// When the hosted OAuth proxy is active this server is itself the
	// authorization server (minting per-user tokens), not a plain
	// bearer-passthrough that forwards a client-supplied token verbatim.
	return proxyEnabled ? 'oauth-proxy' : 'bearer-passthrough';
}
