import type { OAuthMetadata } from '@modelcontextprotocol/server';
import type { ProxyConfig } from './proxyConfig.ts';

// The SDK's RFC 8414 document type, narrowed to the fields this proxy always
// emits: the spec and its registry extensions make them optional, but clients
// pick a compatible flow from these advertisements (grant types, auth
// methods, PKCE, DCR, iss, CIMD).
export type AsMetadataDoc = OAuthMetadata &
	Required<
		Pick<
			OAuthMetadata,
			| 'registration_endpoint'
			| 'grant_types_supported'
			| 'code_challenge_methods_supported'
			| 'token_endpoint_auth_methods_supported'
			| 'authorization_response_iss_parameter_supported'
			| 'client_id_metadata_document_supported'
		>
	>;

/**
 * Builds the RFC 8414 authorization-server metadata document advertising this
 * proxy as the authorization server. All endpoints are rooted at `pc.issuer`
 * (the slash-free issuer identifier produced by resolveProxyConfig).
 */
export function buildAsMetadata(pc: ProxyConfig, scopesSupported?: string[]): AsMetadataDoc {
	return {
		issuer: pc.issuer,
		authorization_endpoint: `${pc.issuer}/authorize`,
		token_endpoint: `${pc.issuer}/token`,
		registration_endpoint: `${pc.issuer}/register`,
		response_types_supported: ['code'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		code_challenge_methods_supported: ['S256'],
		token_endpoint_auth_methods_supported: ['none'],
		authorization_response_iss_parameter_supported: true,
		client_id_metadata_document_supported: true,
		...(scopesSupported ? { scopes_supported: scopesSupported } : {}),
	};
}
