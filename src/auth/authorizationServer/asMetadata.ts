import type { ProxyConfig } from './proxyConfig.js';

export interface AsMetadataDoc {
	issuer: string;
	authorization_endpoint: string;
	token_endpoint: string;
	registration_endpoint: string;
	response_types_supported: string[];
	grant_types_supported: string[];
	code_challenge_methods_supported: string[];
	token_endpoint_auth_methods_supported: string[];
	authorization_response_iss_parameter_supported: boolean;
	scopes_supported?: string[];
}

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
		...(scopesSupported ? { scopes_supported: scopesSupported } : {}),
	};
}
