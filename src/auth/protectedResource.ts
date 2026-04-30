// src/auth/protectedResource.ts
import type { AsMetadata } from './metadata.js';

const RESOURCE_DOCUMENTATION =
	'https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/blob/master/docs/configuration.md#oauth';

export interface ProtectedResourceInput {
	wikis: Record<string, { oauth2ClientId?: string | null }>;
	defaultWiki: string;
	metadata: AsMetadata;
	requestHost: string | undefined;
	requestProto: 'http' | 'https' | undefined;
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
	if (!anyWikiHasOAuth(input.wikis)) {
		return undefined;
	}

	const resource = resolvePublicBase(input.requestHost, input.requestProto);

	const doc: ProtectedResourceDoc = {
		resource,
		authorization_servers: [input.metadata.issuer],
		bearer_methods_supported: ['header'],
		resource_documentation: RESOURCE_DOCUMENTATION,
	};

	if (Array.isArray(input.metadata.scopes_supported)) {
		doc.scopes_supported = input.metadata.scopes_supported;
	}

	return doc;
}
