import type { ProxyStore } from './proxyStore.js';
import { isAllowedRedirect } from './redirectPolicy.js';

export interface RegisterResult {
	status: number;
	body: Record<string, unknown>;
}

// RFC 7591 Dynamic Client Registration facade. Validates that every requested
// redirect_uri passes the proxy's redirect policy, then mints a public client
// (token_endpoint_auth_method 'none', PKCE-only). The pure handler is exported
// separately from the Express route so it can be unit-tested without booting
// the side-effecting transport module.
export function handleRegister(body: unknown, store: ProxyStore): RegisterResult {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RFC 7591 request body is untyped JSON; fields are validated individually below
	const b = (body ?? {}) as Record<string, unknown>;
	const redirectUris = Array.isArray(b.redirect_uris)
		? b.redirect_uris.filter((u): u is string => typeof u === 'string')
		: [];
	if (redirectUris.length === 0) {
		return {
			status: 400,
			body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' },
		};
	}
	if (!redirectUris.every(isAllowedRedirect)) {
		return {
			status: 400,
			body: { error: 'invalid_redirect_uri', error_description: 'a redirect_uri is not permitted' },
		};
	}
	const scopes = typeof b.scope === 'string' ? b.scope.split(' ').filter(Boolean) : [];
	const name = typeof b.client_name === 'string' ? b.client_name : 'MCP client';
	const client = store.putClient({ redirectUris, scopes, name });
	return {
		status: 201,
		body: {
			client_id: client.clientId,
			client_id_issued_at: Math.floor(client.createdAt / 1000),
			redirect_uris: client.redirectUris,
			token_endpoint_auth_method: 'none',
			grant_types: ['authorization_code', 'refresh_token'],
			response_types: ['code'],
			client_name: client.name,
		},
	};
}
