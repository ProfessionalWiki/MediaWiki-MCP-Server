import type { ProxyStore } from './proxyStore.js';

export interface RegisterResult {
	status: number;
	body: Record<string, unknown>;
}

// Bound per-record memory on the unauthenticated /register endpoint. (Request-rate
// limiting belongs at the edge — Caddy/Anubis front this service.)
const MAX_REDIRECT_URIS = 10;
const MAX_CLIENT_NAME_LENGTH = 256;

// RFC 7591 Dynamic Client Registration facade. Validates that every requested
// redirect_uri passes the caller-supplied redirect policy, then mints a public
// client (token_endpoint_auth_method 'none', PKCE-only). The pure handler is
// exported separately from the Express route so it can be unit-tested without
// booting the side-effecting transport module.
export function handleRegister(
	body: unknown,
	store: ProxyStore,
	isAllowed: (uri: string) => boolean,
): RegisterResult {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- RFC 7591 request body is untyped JSON; fields are validated individually below
	const b = (body ?? {}) as Record<string, unknown>;
	const redirectUris = Array.isArray(b.redirect_uris)
		? [...new Set(b.redirect_uris.filter((u): u is string => typeof u === 'string'))]
		: [];
	if (redirectUris.length === 0) {
		return {
			status: 400,
			body: { error: 'invalid_redirect_uri', error_description: 'redirect_uris is required' },
		};
	}
	if (redirectUris.length > MAX_REDIRECT_URIS) {
		return {
			status: 400,
			body: {
				error: 'invalid_redirect_uri',
				error_description: `too many redirect_uris (max ${MAX_REDIRECT_URIS})`,
			},
		};
	}
	if (!redirectUris.every(isAllowed)) {
		return {
			status: 400,
			body: { error: 'invalid_redirect_uri', error_description: 'a redirect_uri is not permitted' },
		};
	}
	const scopes = typeof b.scope === 'string' ? b.scope.split(' ').filter(Boolean) : [];
	// Truncate the client-supplied name so a single record can't hold an unbounded string.
	const name = (typeof b.client_name === 'string' ? b.client_name : 'MCP client').slice(
		0,
		MAX_CLIENT_NAME_LENGTH,
	);
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
