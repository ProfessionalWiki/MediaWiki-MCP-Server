import type { WikiConfig } from '../config/loadConfig.ts';
import { isCredentialConfigured } from '../config/loadConfig.ts';
import type { HostedProxy } from '../auth/authorizationServer/hostedProxy.ts';

// How the server authenticates, to its wikis and its callers. Consumed by runtime/
// (banner, wiki capability) and transport/ (the startup bearer guard,
// streamableHttp) alike, so it lives here rather than in transport to keep those
// callers pointing down.

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

/** How the deployment lets callers authenticate, decided once at startup. */
export interface AuthPolicy {
	/** On stdio the server signs in to an OAuth wiki itself, through the user's browser. */
	readonly transport: Transport;
	/**
	 * Forward a caller-supplied bearer to the wiki. Deprecated and off unless opted
	 * into: MCP servers must not accept tokens that were not issued for them.
	 */
	readonly bearerPassthrough: boolean;
	/** Let a request without a token act as a wiki's configured credentials. */
	readonly staticFallback: boolean;
	/** On HTTP, when configured: this server signs callers in to one wiki and issues their tokens. */
	readonly hostedProxy: HostedProxy | null;
}

export function readAuthPolicy(
	env: NodeJS.ProcessEnv,
	transport: Transport,
	hostedProxy: HostedProxy | null,
): AuthPolicy {
	return {
		transport,
		bearerPassthrough: env.MCP_ALLOW_BEARER_PASSTHROUGH === 'true',
		staticFallback: env.MCP_ALLOW_STATIC_FALLBACK === 'true',
		hostedProxy,
	};
}

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	auth: AuthPolicy,
): AuthShape {
	const anyStatic = Object.values(wikis).some(hasStaticCredentials);
	if (anyStatic) {
		return 'static-credential';
	}
	if (auth.transport !== 'http') {
		return 'anonymous';
	}
	// When the hosted OAuth proxy is active this server is itself the
	// authorization server (minting per-user tokens), not a plain
	// bearer-passthrough that forwards a client-supplied token verbatim.
	if (auth.hostedProxy !== null) {
		return 'oauth-proxy';
	}
	return auth.bearerPassthrough ? 'bearer-passthrough' : 'anonymous';
}
