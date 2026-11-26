import { randomUUID } from 'node:crypto';
import { exportJWK, generateKeyPair, SignJWT, type JWTPayload } from 'jose';
import type { ExchangeClient } from '../../src/auth/authorizationServer/exchangeClient.ts';

export const EXCHANGE_CLIENT_ID = 'backend';
export const EXCHANGE_CONSUMER = 'BACKEND-CONSUMER';
/** A public EC P-256 key, for tests that parse a key set without signing anything. */
export const PUBLIC_EC_JWK = {
	kty: 'EC',
	crv: 'P-256',
	x: 'PYimGWh99Sp1jxrF0qbSEj61Ufyq_DtEv1rQaTMazzI',
	y: 'XJYetqYVDE2CgjqgkfXQ1KylWeCVeT9LQOGd5WN_XYI',
	kid: 'k',
};
const TOKEN_EXCHANGE_GRANT = 'urn:ietf:params:oauth:grant-type:token-exchange';
const ACCESS_TOKEN_TYPE = 'urn:ietf:params:oauth:token-type:access_token';
export const CLIENT_ASSERTION_TYPE = 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer';

export interface ExchangeClientFixture {
	client: ExchangeClient;
	/** A client assertion addressed to `audience`; `claims` override the valid defaults. */
	assertion(audience: string, claims?: JWTPayload): Promise<string>;
	/** A token request exchanging `subjectToken`, authenticated for `issuer`. */
	exchangeBody(issuer: string, subjectToken: string): Promise<Record<string, string>>;
}

export async function exchangeClientFixture(): Promise<ExchangeClientFixture> {
	const { publicKey, privateKey } = await generateKeyPair('ES256');
	const client: ExchangeClient = {
		clientId: EXCHANGE_CLIENT_ID,
		jwks: { keys: [{ ...(await exportJWK(publicKey)), kid: 'k1' }] },
		consumers: [EXCHANGE_CONSUMER],
	};
	const assertion = (audience: string, claims: JWTPayload = {}): Promise<string> => {
		const now = Math.floor(Date.now() / 1000);
		return new SignJWT({
			iss: EXCHANGE_CLIENT_ID,
			sub: EXCHANGE_CLIENT_ID,
			aud: audience,
			jti: randomUUID(),
			iat: now,
			exp: now + 60,
			...claims,
		})
			.setProtectedHeader({ alg: 'ES256', kid: 'k1', typ: 'client-authentication+jwt' })
			.sign(privateKey);
	};
	return {
		client,
		assertion,
		exchangeBody: async (issuer, subjectToken) => ({
			grant_type: TOKEN_EXCHANGE_GRANT,
			client_assertion_type: CLIENT_ASSERTION_TYPE,
			client_assertion: await assertion(issuer),
			subject_token: subjectToken,
			subject_token_type: ACCESS_TOKEN_TYPE,
		}),
	};
}

/** A wiki OAuth 2 access token as Extension:OAuth shapes it; nothing here checks its signature. */
export function wikiAccessToken(
	claims: { aud?: string; lifetimeSeconds?: number; scopes?: string[] } = {},
): Promise<string> {
	const now = Math.floor(Date.now() / 1000);
	return new SignJWT({
		aud: claims.aud ?? EXCHANGE_CONSUMER,
		sub: '42',
		jti: randomUUID(),
		exp: now + (claims.lifetimeSeconds ?? 600),
		scopes: claims.scopes ?? ['basic', 'editpage'],
	})
		.setProtectedHeader({ alg: 'HS256' })
		.sign(new TextEncoder().encode('wiki-signing-key-not-checked-by-the-proxy'));
}
