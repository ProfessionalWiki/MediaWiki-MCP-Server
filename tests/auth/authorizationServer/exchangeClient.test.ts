import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import {
	authenticateExchangeClient,
	parseExchangeClient,
} from '../../../src/auth/authorizationServer/exchangeClient.ts';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.ts';
import {
	CLIENT_ASSERTION_TYPE,
	EXCHANGE_CLIENT_ID,
	PUBLIC_EC_JWK,
	exchangeClientFixture,
	type ExchangeClientFixture,
} from '../../helpers/exchangeClient.ts';

const ISSUER = 'https://wiki.example/mcp';
const PUBLIC_JWK = PUBLIC_EC_JWK;

function parse(env: NodeJS.ProcessEnv): ReturnType<typeof parseExchangeClient> {
	return parseExchangeClient(env, 'OWN-CONSUMER');
}

function rsaKeyOfBits(bits: number): Record<string, string> {
	return { kty: 'RSA', e: 'AQAB', n: Buffer.alloc(bits / 8, 0xff).toString('base64url'), kid: 'k' };
}

function withKeys(...keys: unknown[]): NodeJS.ProcessEnv {
	return {
		MCP_OAUTH_EXCHANGE_CLIENT_ID: 'backend',
		MCP_OAUTH_EXCHANGE_CLIENT_JWKS: JSON.stringify({ keys }),
	};
}

describe('parseExchangeClient', () => {
	it('leaves token exchange off when neither variable is set', () => {
		expect(parse({})).toBeNull();
	});

	it('refuses a client id without keys', () => {
		expect(() => parse({ MCP_OAUTH_EXCHANGE_CLIENT_ID: 'backend' })).toThrow(/Set both/);
	});

	it('refuses keys without a client id', () => {
		expect(() =>
			parse({ MCP_OAUTH_EXCHANGE_CLIENT_JWKS: JSON.stringify({ keys: [PUBLIC_JWK] }) }),
		).toThrow(/Set both/);
	});

	it('refuses keys that are not JSON', () => {
		expect(() =>
			parse({
				MCP_OAUTH_EXCHANGE_CLIENT_ID: 'backend',
				MCP_OAUTH_EXCHANGE_CLIENT_JWKS: '-----BEGIN',
			}),
		).toThrow(/MCP_OAUTH_EXCHANGE_CLIENT_JWKS/);
	});

	it('refuses a key set holding no keys', () => {
		expect(() => parse(withKeys())).toThrow(/at least one key/);
	});

	it('refuses a private key', () => {
		expect(() => parse(withKeys({ ...PUBLIC_JWK, d: 'secret' }))).toThrow(/private key/);
	});

	it('refuses a symmetric key', () => {
		expect(() => parse(withKeys({ kty: 'oct', k: 'secret' }))).toThrow(/only RSA keys and EC keys/);
	});

	it('refuses an RSA key shorter than 2048 bits', () => {
		expect(() => parse(withKeys(rsaKeyOfBits(1024)))).toThrow(/2048 bits/);
	});

	it('accepts a 2048-bit RSA key', () => {
		expect(parse(withKeys(rsaKeyOfBits(2048)))?.jwks.keys).toHaveLength(1);
	});

	it('refuses an EC key on a curve ES256 does not use', () => {
		const p384 = {
			kty: 'EC',
			crv: 'P-384',
			x: 'jh6S_PRyrRgM2bxZ_3JMUmBQN_LkM_zAyNXKD8V1WMd155U4eOShFC2h6PalpEsV',
			y: '94Vyt9crhfssg5ol-bbS3S5qpdE1_ddTQbHQfZ1Pj6Ty9n8GmQblRUZMJPqBKvDN',
			kid: 'k',
		};
		expect(() => parse(withKeys(p384))).toThrow(/P-256/);
	});

	it('refuses a key that is not a valid public key', () => {
		expect(() => parse(withKeys({ ...PUBLIC_JWK, x: 'x' }))).toThrow(/not a valid public key/);
	});

	it('refuses a key whose operations exclude verifying', () => {
		expect(() => parse(withKeys({ ...PUBLIC_JWK, key_ops: ['sign'] }))).toThrow(/not for ES256/);
	});

	it('refuses a key meant for encryption', () => {
		expect(() => parse(withKeys({ ...PUBLIC_JWK, use: 'enc' }))).toThrow(/not for ES256/);
	});

	it('refuses a key meant for another algorithm', () => {
		expect(() => parse(withKeys({ ...PUBLIC_JWK, alg: 'ES384' }))).toThrow(/not for ES256/);
	});

	it('refuses a key without a kid', () => {
		const { kid: _kid, ...keyWithoutKid } = PUBLIC_JWK;
		expect(() => parse(withKeys(keyWithoutKid))).toThrow(/kid/);
	});

	it('refuses two keys sharing a kid', () => {
		expect(() => parse(withKeys(PUBLIC_JWK, PUBLIC_JWK))).toThrow(/kid/);
	});

	it('accepts a key marked for ES256 signatures', () => {
		expect(parse(withKeys({ ...PUBLIC_JWK, alg: 'ES256', use: 'sig' }))?.jwks.keys).toHaveLength(1);
	});

	it('keeps every key of the set, so keys can be rotated', () => {
		const client = parse(withKeys({ ...PUBLIC_JWK, kid: 'old' }, { ...PUBLIC_JWK, kid: 'new' }));
		expect(client?.jwks.keys.map((key) => key.kid)).toEqual(['old', 'new']);
	});

	it('accepts tokens issued to the consumers a deployment lists', () => {
		const client = parse({ ...withKeys(PUBLIC_JWK), MCP_OAUTH_EXCHANGE_CONSUMERS: 'one, two' });
		expect(client?.consumers).toEqual(['one', 'two']);
	});
});

describe('authenticateExchangeClient', () => {
	afterEach(() => {
		vi.useRealTimers();
	});

	let fixture: ExchangeClientFixture;
	let other: ExchangeClientFixture;

	beforeAll(async () => {
		fixture = await exchangeClientFixture();
		other = await exchangeClientFixture();
	});

	function authenticate(
		assertion: string,
		extra: Record<string, unknown> = {},
		store = new InMemoryProxyStore(),
	): Promise<boolean> {
		return authenticateExchangeClient(
			{ client_assertion_type: CLIENT_ASSERTION_TYPE, client_assertion: assertion, ...extra },
			fixture.client,
			ISSUER,
			store,
		);
	}

	it("accepts an assertion signed with the client's key", async () => {
		expect(await authenticate(await fixture.assertion(ISSUER))).toBe(true);
	});

	it('accepts a request that also names the client', async () => {
		expect(
			await authenticate(await fixture.assertion(ISSUER), { client_id: EXCHANGE_CLIENT_ID }),
		).toBe(true);
	});

	it('refuses an assertion signed with another key', async () => {
		expect(await authenticate(await other.assertion(ISSUER))).toBe(false);
	});

	it('refuses an assertion addressed to the token endpoint', async () => {
		expect(await authenticate(await fixture.assertion(`${ISSUER}/token`))).toBe(false);
	});

	it('refuses an assertion with a second audience', async () => {
		expect(
			await authenticate(
				await fixture.assertion(ISSUER, { aud: [ISSUER, 'https://other.example'] }),
			),
		).toBe(false);
	});

	it('refuses an assertion issued by another client', async () => {
		expect(await authenticate(await fixture.assertion(ISSUER, { iss: 'other' }))).toBe(false);
	});

	it('refuses an assertion about another client', async () => {
		expect(await authenticate(await fixture.assertion(ISSUER, { sub: 'other' }))).toBe(false);
	});

	it('refuses a request naming another client', async () => {
		expect(await authenticate(await fixture.assertion(ISSUER), { client_id: 'other' })).toBe(false);
	});

	it('refuses another client assertion type', async () => {
		expect(
			await authenticate(await fixture.assertion(ISSUER), {
				client_assertion_type: 'urn:ietf:params:oauth:client-assertion-type:saml2-bearer',
			}),
		).toBe(false);
	});

	it('refuses an expired assertion', async () => {
		const longAgo = Math.floor(Date.now() / 1000) - 600;
		expect(
			await authenticate(await fixture.assertion(ISSUER, { iat: longAgo, exp: longAgo + 60 })),
		).toBe(false);
	});

	it('accepts an assertion valid for five minutes from a clock running slightly ahead', async () => {
		const exp = Math.floor(Date.now() / 1000) + 5 * 60 + 10;
		expect(await authenticate(await fixture.assertion(ISSUER, { exp }))).toBe(true);
	});

	it('refuses an assertion valid for longer than five minutes', async () => {
		const exp = Math.floor(Date.now() / 1000) + 6 * 60;
		expect(await authenticate(await fixture.assertion(ISSUER, { exp }))).toBe(false);
	});

	it('refuses an assertion without an id', async () => {
		expect(await authenticate(await fixture.assertion(ISSUER, { jti: undefined }))).toBe(false);
	});

	it('refuses an assertion replayed near the end of its lifetime', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		let elapsed = 0;
		const store = new InMemoryProxyStore(() => elapsed);
		const exp = Math.floor(Date.now() / 1000) + 5 * 60 + 10;
		const assertion = await fixture.assertion(ISSUER, { exp });
		await authenticate(assertion, {}, store);
		elapsed = 5 * 60 * 1000 + 20_000;
		vi.setSystemTime(Date.now() + elapsed);

		expect(await authenticate(assertion, {}, store)).toBe(false);
	});

	it('refuses an assertion without an expiry', async () => {
		expect(await authenticate(await fixture.assertion(ISSUER, { exp: undefined }))).toBe(false);
	});

	it('accepts an assertion from a clock running slightly behind', async () => {
		const now = Math.floor(Date.now() / 1000);
		expect(
			await authenticate(await fixture.assertion(ISSUER, { iat: now - 70, exp: now - 10 })),
		).toBe(true);
	});
});
