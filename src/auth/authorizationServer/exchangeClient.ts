import { createPublicKey } from 'node:crypto';
import { createLocalJWKSet, jwtVerify, type JSONWebKeySet, type JWK, type JWTPayload } from 'jose';
import type { ProxyStore } from './proxyStore.ts';

/** A backend the proxy lets exchange wiki access tokens it already holds for proxy tokens. */
export interface ExchangeClient {
	clientId: string;
	/** The public keys its client assertions are signed with. */
	jwks: JSONWebKeySet;
	/** Keys of the wiki OAuth consumers whose access tokens it may exchange. */
	consumers: string[];
}

const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';
const SIGNING_ALG_FOR_KEY_TYPE = new Map([
	['EC', 'ES256'],
	['RSA', 'RS256'],
]);
const ASSERTION_SIGNING_ALGS = [...SIGNING_ALG_FOR_KEY_TYPE.values()];
// jose refuses smaller RSA keys.
const MIN_RSA_MODULUS_BITS = 2048;

// Bounds how long a captured assertion stays usable.
const MAX_ASSERTION_LIFETIME_MS = 5 * 60 * 1000;
const CLOCK_TOLERANCE_SECONDS = 30;
// Outlasts the latest moment an accepted assertion still verifies: jose compares
// whole seconds, so it accepts up to a second past exp plus the tolerance.
const ASSERTION_ID_MEMORY_MS = MAX_ASSERTION_LIFETIME_MS + (2 * CLOCK_TOLERANCE_SECONDS + 1) * 1000;

export class ExchangeClientConfigError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ExchangeClientConfigError';
	}
}

export function parseExchangeClient(
	env: NodeJS.ProcessEnv,
	ownConsumer: string,
): ExchangeClient | null {
	const clientId = env.MCP_OAUTH_EXCHANGE_CLIENT_ID?.trim();
	const jwks = env.MCP_OAUTH_EXCHANGE_CLIENT_JWKS?.trim();
	if (!clientId && !jwks) {
		return null;
	}
	if (!clientId || !jwks) {
		throw new ExchangeClientConfigError(
			'Set both MCP_OAUTH_EXCHANGE_CLIENT_ID and MCP_OAUTH_EXCHANGE_CLIENT_JWKS, or neither.',
		);
	}
	return {
		clientId,
		jwks: parsePublicJwks(jwks),
		consumers: parseConsumers(env.MCP_OAUTH_EXCHANGE_CONSUMERS) ?? [ownConsumer],
	};
}

function parsePublicJwks(raw: string): JSONWebKeySet {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		throw new ExchangeClientConfigError('MCP_OAUTH_EXCHANGE_CLIENT_JWKS is not valid JSON.');
	}
	const keys: unknown = isObject(parsed) ? parsed.keys : undefined;
	if (!Array.isArray(keys) || keys.length === 0) {
		throw new ExchangeClientConfigError(
			'MCP_OAUTH_EXCHANGE_CLIENT_JWKS must be a JWKS: an object whose "keys" array holds at least one key.',
		);
	}
	for (const key of keys) {
		assertSigningKey(key);
	}
	const kids = new Set(keys.map((key: JWK) => key.kid));
	if (keys.some((key: JWK) => typeof key.kid !== 'string') || kids.size < keys.length) {
		throw new ExchangeClientConfigError(
			'MCP_OAUTH_EXCHANGE_CLIENT_JWKS: give each key its own "kid".',
		);
	}
	return { keys };
}

// Refuses at startup a key jose would never verify an ES256 or RS256 assertion with,
// rather than every exchange failing.
function assertSigningKey(key: unknown): asserts key is JWK {
	const alg = isObject(key) ? SIGNING_ALG_FOR_KEY_TYPE.get(String(key.kty)) : undefined;
	if (!isObject(key) || !alg) {
		throw onlySigningKeys();
	}
	if ('d' in key) {
		throw new ExchangeClientConfigError(
			'MCP_OAUTH_EXCHANGE_CLIENT_JWKS holds a private key; give the server only the public half.',
		);
	}
	const details = importedKeyDetails(key);
	if (key.kty === 'EC' && details.namedCurve !== 'prime256v1') {
		throw onlySigningKeys();
	}
	if (key.kty === 'RSA' && (details.modulusLength ?? 0) < MIN_RSA_MODULUS_BITS) {
		throw new ExchangeClientConfigError(
			'MCP_OAUTH_EXCHANGE_CLIENT_JWKS holds an RSA key shorter than 2048 bits.',
		);
	}
	const keyOps = key.key_ops;
	if (
		(key.alg !== undefined && key.alg !== alg) ||
		(key.use !== undefined && key.use !== 'sig') ||
		(keyOps !== undefined && !(Array.isArray(keyOps) && keyOps.includes('verify')))
	) {
		throw new ExchangeClientConfigError(
			`MCP_OAUTH_EXCHANGE_CLIENT_JWKS holds a key that is not for ${alg} signatures.`,
		);
	}
}

function importedKeyDetails(key: Record<string, unknown>): {
	namedCurve?: string;
	modulusLength?: number;
} {
	try {
		return createPublicKey({ key, format: 'jwk' }).asymmetricKeyDetails ?? {};
	} catch {
		throw new ExchangeClientConfigError(
			'MCP_OAUTH_EXCHANGE_CLIENT_JWKS holds a key that is not a valid public key.',
		);
	}
}

function onlySigningKeys(): ExchangeClientConfigError {
	return new ExchangeClientConfigError(
		'MCP_OAUTH_EXCHANGE_CLIENT_JWKS may hold only RSA keys and EC keys on the P-256 curve.',
	);
}

function parseConsumers(raw: string | undefined): string[] | undefined {
	const consumers = (raw ?? '')
		.split(',')
		.map((c) => c.trim())
		.filter(Boolean);
	return consumers.length > 0 ? consumers : undefined;
}

function isObject(v: unknown): v is Record<string, unknown> {
	return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Whether the token request authenticates as `client` with a signed JWT (RFC 7523,
 * audience per RFC 10070). Each assertion is accepted once.
 */
export async function authenticateExchangeClient(
	body: Record<string, unknown>,
	client: ExchangeClient,
	issuer: string,
	store: ProxyStore,
): Promise<boolean> {
	if (body.client_assertion_type !== CLIENT_ASSERTION_TYPE) {
		return false;
	}
	if (typeof body.client_assertion !== 'string') {
		return false;
	}
	if (body.client_id !== undefined && body.client_id !== client.clientId) {
		return false;
	}

	let payload: JWTPayload;
	try {
		({ payload } = await jwtVerify(body.client_assertion, createLocalJWKSet(client.jwks), {
			algorithms: ASSERTION_SIGNING_ALGS,
			issuer: client.clientId,
			subject: client.clientId,
			clockTolerance: CLOCK_TOLERANCE_SECONDS,
		}));
	} catch {
		return false;
	}
	if (typeof payload.exp !== 'number' || typeof payload.jti !== 'string') {
		return false;
	}

	const remainingMs = payload.exp * 1000 - Date.now();
	if (
		!hasSoleAudience(payload, issuer) ||
		remainingMs > MAX_ASSERTION_LIFETIME_MS + CLOCK_TOLERANCE_SECONDS * 1000
	) {
		return false;
	}
	return store.claimAssertionId(payload.jti, ASSERTION_ID_MEMORY_MS);
}

function hasSoleAudience(payload: JWTPayload, issuer: string): boolean {
	const aud = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
	return aud.length === 1 && aud[0] === issuer;
}
