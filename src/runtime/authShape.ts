import type { WikiConfig } from '../config/loadConfig.ts';
import { isCredentialConfigured } from '../config/loadConfig.ts';

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

export function usesOAuthSignIn<T extends { oauth2ClientId?: string | null }>(
	wiki: T,
): wiki is T & { oauth2ClientId: string } {
	return typeof wiki.oauth2ClientId === 'string' && wiki.oauth2ClientId.trim() !== '';
}

export type AuthShape = 'anonymous' | 'static-credential' | 'bearer-passthrough' | 'oauth-proxy';
export type Transport = 'stdio' | 'http';

/** How the deployment lets callers authenticate, read once from the environment at startup. */
export interface AuthPolicy {
	/**
	 * Forward a caller-supplied bearer to the wiki. Deprecated and off unless opted
	 * into: MCP servers must not accept tokens that were not issued for them.
	 */
	readonly bearerPassthrough: boolean;
	/** Let a request without a token act as a wiki's configured credentials. */
	readonly staticFallback: boolean;
}

export function readAuthPolicy(env: NodeJS.ProcessEnv): AuthPolicy {
	return {
		bearerPassthrough: env.MCP_ALLOW_BEARER_PASSTHROUGH === 'true',
		staticFallback: env.MCP_ALLOW_STATIC_FALLBACK === 'true',
	};
}

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	transport: Transport,
	proxyEnabled: boolean,
	passthroughEnabled: boolean,
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
	if (proxyEnabled) {
		return 'oauth-proxy';
	}
	return passthroughEnabled ? 'bearer-passthrough' : 'anonymous';
}
