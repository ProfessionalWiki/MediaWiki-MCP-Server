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

export type AuthShape = 'anonymous' | 'static-credential' | 'bearer-passthrough' | 'oauth-proxy';
export type Transport = 'stdio' | 'http';

// Forwarding a client-supplied bearer to the wiki is deprecated and off unless a
// deployment opts in: MCP servers must not accept tokens that were not issued for
// them. Reading the environment here keeps the single source of truth beside the
// shape it names, since the classifier is what the banner reports.
export function bearerPassthroughEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MCP_ALLOW_BEARER_PASSTHROUGH === 'true';
}

// Whether the HTTP transport accepts `Authorization: Basic` bot-password
// credentials from the caller. On by default, unlike bearer passthrough: those
// credentials were issued to the caller for this wiki and are handed over
// deliberately, so acting as that user attributes every write to them — the
// opposite of the shared-identity shape the static-credential guard refuses. An
// operator whose deployment authenticates some other way sets it to `false`, and
// a Basic header is then refused rather than quietly ignored. Read here beside
// the other credential-shape questions so runtime/ and transport/ agree.
export function basicAuthEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
	return env.MCP_ALLOW_BASIC_AUTH !== 'false';
}

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	transport: Transport,
	proxyEnabled = false,
	passthroughEnabled = bearerPassthroughEnabled(),
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
