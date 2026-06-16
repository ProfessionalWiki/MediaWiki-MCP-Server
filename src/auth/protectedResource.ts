// src/auth/protectedResource.ts
import type { AsMetadata } from './metadata.js';

const RESOURCE_DOCUMENTATION =
	'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/blob/master/docs/configuration.md#oauth';

export interface ProtectedResourceInput {
	wikis: Record<string, { oauth2ClientId?: string | null }>;
	metadatas: readonly AsMetadata[];
	requestHost: string | undefined;
	requestProto: 'http' | 'https' | undefined;
	/**
	 * When the hosted OAuth proxy is enabled, this server is itself the
	 * authorization server. Pass the proxy issuer(s) here to advertise self
	 * instead of the per-wiki upstream issuers derived from `metadatas`.
	 */
	authorizationServersOverride?: readonly string[];
}

export interface ProtectedResourceDoc {
	resource: string;
	authorization_servers: string[];
	bearer_methods_supported: string[];
	scopes_supported?: string[];
	resource_documentation?: string;
}

function anyWikiHasOAuth(wikis: Record<string, { oauth2ClientId?: string | null }>): boolean {
	return Object.values(wikis).some(
		(w) => typeof w.oauth2ClientId === 'string' && w.oauth2ClientId.length > 0,
	);
}

/**
 * Resolves the public base URL of the MCP server with a guaranteed trailing
 * slash. Honours `MCP_PUBLIC_URL` when set; otherwise builds from request
 * proto+host. Used for both the protected-resource doc's `resource` field and
 * the WWW-Authenticate `resource_metadata` URL so the two stay aligned.
 */
export function resolvePublicBase(
	requestHost: string | undefined,
	requestProto: 'http' | 'https' | undefined,
): string {
	const fromEnv = process.env.MCP_PUBLIC_URL;
	let base: string;
	if (typeof fromEnv === 'string' && fromEnv.length > 0) {
		base = fromEnv;
	} else if (requestHost !== undefined && requestProto !== undefined) {
		base = `${requestProto}://${requestHost}/`;
	} else {
		base = 'https://localhost/';
	}
	return base.endsWith('/') ? base : `${base}/`;
}

export function buildProtectedResource(
	input: ProtectedResourceInput,
): ProtectedResourceDoc | undefined {
	if (!anyWikiHasOAuth(input.wikis) || input.metadatas.length === 0) {
		return undefined;
	}

	// The RFC 8707/9728 resource identifier must equal the canonical MCP server
	// URL the client connects to — slash-free, matching the AS `issuer`. Real MCP
	// clients (e.g. the SDK) compare it verbatim against their configured server
	// URL, so a trailing slash here fails auth ("Protected resource .../mcp/ does
	// not match expected .../mcp"). resolvePublicBase keeps its trailing slash for
	// building the resource_metadata URL; strip it for the identifier only.
	const resource = resolvePublicBase(input.requestHost, input.requestProto).replace(/\/+$/, '');
	const issuers =
		input.authorizationServersOverride !== undefined
			? [...input.authorizationServersOverride]
			: [...new Set(input.metadatas.map((m) => m.issuer))];
	const scopes = [...new Set(input.metadatas.flatMap((m) => m.scopes_supported ?? []))];

	const doc: ProtectedResourceDoc = {
		resource,
		authorization_servers: issuers,
		bearer_methods_supported: ['header'],
		resource_documentation: RESOURCE_DOCUMENTATION,
	};

	if (scopes.length > 0) {
		doc.scopes_supported = scopes;
	}

	return doc;
}
