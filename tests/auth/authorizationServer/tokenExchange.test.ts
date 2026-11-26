import { describe, it, expect, beforeAll, afterEach, vi } from 'vitest';
import { decodeJwt } from 'jose';
import {
	handleTokenExchange,
	type FetchProfile,
} from '../../../src/auth/authorizationServer/tokenExchange.ts';
import { InMemoryProxyStore, issuedFor } from '../../../src/auth/authorizationServer/proxyStore.ts';
import { verifyAccessToken } from '../../../src/auth/authorizationServer/jwt.ts';
import { OAuthFlowError } from '../../../src/auth/oauthFlow.ts';
import type { TokenResult } from '../../../src/auth/authorizationServer/token.ts';
import { fakeProxyConfig } from '../../helpers/fakeProxyConfig.ts';
import {
	EXCHANGE_CONSUMER,
	exchangeClientFixture,
	wikiAccessToken,
	type ExchangeClientFixture,
} from '../../helpers/exchangeClient.ts';
import type { ExchangeClient } from '../../../src/auth/authorizationServer/exchangeClient.ts';

const pc = fakeProxyConfig({
	issuer: 'https://wiki.example/mcp',
	internalBase: 'http://mediawiki.svc',
	tokenTtlMs: 55 * 60 * 1000,
});

let fixture: ExchangeClientFixture;

beforeAll(async () => {
	fixture = await exchangeClientFixture();
});

afterEach(() => {
	vi.useRealTimers();
});

function profileOf(sub: string): FetchProfile {
	return async () => ({ sub });
}

function failingProfile(kind: 'invalid_token' | 'transient'): FetchProfile {
	return async () => {
		throw new OAuthFlowError(kind, 'refused');
	};
}

async function exchange(
	subjectToken: string,
	{
		extra = {},
		fetchProfile = profileOf('42'),
		store = new InMemoryProxyStore(),
		client = fixture.client,
	}: {
		extra?: Record<string, unknown>;
		fetchProfile?: FetchProfile;
		store?: InMemoryProxyStore;
		client?: ExchangeClient;
	} = {},
): Promise<TokenResult> {
	const body = { ...(await fixture.exchangeBody(pc.issuer, subjectToken)), ...extra };
	return handleTokenExchange(body, pc, client, store, fetchProfile);
}

function listingConsumers(...consumers: string[]): ExchangeClient {
	return { ...fixture.client, consumers };
}

// Decodes to the given claims; nothing in the exchange checks a wiki token's signature.
function unsignedToken(claims: Record<string, unknown>): string {
	const part = (v: unknown): string => Buffer.from(JSON.stringify(v)).toString('base64url');
	return `${part({ alg: 'none' })}.${part(claims)}.sig`;
}

async function storedFor(result: TokenResult, store: InMemoryProxyStore) {
	const { upstreamTokenId } = await verifyAccessToken(String(result.body.access_token), pc);
	return { upstreamTokenId, token: store.getUpstreamToken(upstreamTokenId) };
}

describe('handleTokenExchange', () => {
	it('issues an access token that stands for the wiki token', async () => {
		const store = new InMemoryProxyStore();
		const wikiToken = await wikiAccessToken();

		const result = await exchange(wikiToken, { store });

		expect((await storedFor(result, store)).token?.accessToken).toBe(wikiToken);
	});

	it('issues a bearer access token and no refresh token', async () => {
		const result = await exchange(await wikiAccessToken());

		expect(result.body).toMatchObject({
			issued_token_type: 'urn:ietf:params:oauth:token-type:access_token',
			token_type: 'Bearer',
		});
		expect(result.body).not.toHaveProperty('refresh_token');
	});

	it('lets the token expire no later than the wiki token', async () => {
		const wikiToken = await wikiAccessToken({ lifetimeSeconds: 600 });

		const result = await exchange(wikiToken);

		expect(result.body.expires_in).toBeGreaterThan(590);
		expect(result.body.expires_in).toBeLessThanOrEqual(600);
		expect(decodeJwt(String(result.body.access_token)).exp).toBeLessThanOrEqual(
			decodeJwt(wikiToken).exp!,
		);
	});

	it('lets the token expire no later than a wiki token that ran down while the wiki checked it', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		const wikiToken = await wikiAccessToken({ lifetimeSeconds: 10 });
		const slowProfile: FetchProfile = async () => {
			vi.setSystemTime(Date.now() + 4000);
			return { sub: '42' };
		};

		const result = await exchange(wikiToken, { fetchProfile: slowProfile });

		expect(decodeJwt(String(result.body.access_token)).exp).toBeLessThanOrEqual(
			decodeJwt(wikiToken).exp!,
		);
	});

	it('lets the token expire with the proxy token lifetime when the wiki token outlives it', async () => {
		const result = await exchange(await wikiAccessToken({ lifetimeSeconds: 7200 }));

		expect(result.body.expires_in).toBe(55 * 60);
	});

	it("checks the token at the wiki's internal profile endpoint", async () => {
		const fetchProfile = vi.fn(profileOf('42'));
		const wikiToken = await wikiAccessToken();

		await exchange(wikiToken, { fetchProfile });

		expect(fetchProfile).toHaveBeenCalledWith(
			'http://mediawiki.svc/w/rest.php/oauth2/resource/profile',
			wikiToken,
		);
	});

	it("lets a user's earlier tokens stand for a wiki token they exchange later that expires later", async () => {
		const store = new InMemoryProxyStore();
		const first = await exchange(await wikiAccessToken({ lifetimeSeconds: 600 }), { store });
		const laterToken = await wikiAccessToken({ lifetimeSeconds: 900 });

		await exchange(laterToken, { store });

		expect((await storedFor(first, store)).token?.accessToken).toBe(laterToken);
	});

	it("keeps a user's stored wiki token when one exchanged later expires sooner", async () => {
		const store = new InMemoryProxyStore();
		const longerToken = await wikiAccessToken({ lifetimeSeconds: 900 });
		const first = await exchange(longerToken, { store });

		await exchange(await wikiAccessToken({ lifetimeSeconds: 600 }), { store });

		expect((await storedFor(first, store)).token?.accessToken).toBe(longerToken);
	});

	it('accepts a wiki token issued to any consumer the client lists', async () => {
		const result = await exchange(await wikiAccessToken(), {
			client: listingConsumers('FIRST', EXCHANGE_CONSUMER, 'LAST'),
		});

		expect(result.status).toBe(200);
	});

	it("stores a user's tokens from each consumer apart", async () => {
		const store = new InMemoryProxyStore();
		const client = listingConsumers(EXCHANGE_CONSUMER, 'OTHER-CONSUMER');
		const fromOne = await exchange(await wikiAccessToken(), { store, client });

		const fromOther = await exchange(await wikiAccessToken({ aud: 'OTHER-CONSUMER' }), {
			store,
			client,
		});

		expect((await storedFor(fromOther, store)).upstreamTokenId).not.toBe(
			(await storedFor(fromOne, store)).upstreamTokenId,
		);
	});

	it('keeps the stored token for this wiki only', async () => {
		const store = new InMemoryProxyStore();

		const result = await exchange(await wikiAccessToken(), { store });

		expect(issuedFor((await storedFor(result, store)).token!, 'another-wiki')).toBe(false);
	});

	it("stores a user's tokens with different grants apart", async () => {
		const store = new InMemoryProxyStore();
		const readOnly = await exchange(await wikiAccessToken({ scopes: ['basic'] }), { store });

		const editing = await exchange(await wikiAccessToken({ scopes: ['basic', 'editpage'] }), {
			store,
		});

		expect((await storedFor(editing, store)).upstreamTokenId).not.toBe(
			(await storedFor(readOnly, store)).upstreamTokenId,
		);
	});

	it('stores each user apart', async () => {
		const store = new InMemoryProxyStore();
		const alice = await exchange(await wikiAccessToken(), { store, fetchProfile: profileOf('42') });

		const bob = await exchange(await wikiAccessToken(), { store, fetchProfile: profileOf('43') });

		expect((await storedFor(bob, store)).upstreamTokenId).not.toBe(
			(await storedFor(alice, store)).upstreamTokenId,
		);
	});

	it('refuses a client that does not authenticate, without asking the wiki', async () => {
		const fetchProfile = vi.fn(profileOf('42'));

		const result = await exchange(await wikiAccessToken(), {
			fetchProfile,
			extra: { client_assertion: 'not-a-jwt' },
		});

		expect(result).toMatchObject({ status: 401, body: { error: 'invalid_client' } });
		expect(fetchProfile).not.toHaveBeenCalled();
	});

	it('refuses a wiki token issued to a consumer the client may not exchange, without asking the wiki', async () => {
		const fetchProfile = vi.fn(profileOf('42'));

		const result = await exchange(await wikiAccessToken({ aud: 'OTHER-CONSUMER' }), {
			fetchProfile,
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
		expect(fetchProfile).not.toHaveBeenCalled();
	});

	it('refuses a wiki token the wiki does not accept', async () => {
		const result = await exchange(await wikiAccessToken(), {
			fetchProfile: failingProfile('invalid_token'),
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('asks for a retry when the wiki cannot be reached', async () => {
		const result = await exchange(await wikiAccessToken(), {
			fetchProfile: failingProfile('transient'),
		});

		expect(result).toMatchObject({ status: 503, body: { error: 'temporarily_unavailable' } });
	});

	it('refuses an expired wiki token', async () => {
		const result = await exchange(await wikiAccessToken({ lifetimeSeconds: -5 }));

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('refuses a subject token without an expiry', async () => {
		const result = await exchange(unsignedToken({ aud: EXCHANGE_CONSUMER }));

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('refuses a subject token that is not a JWT', async () => {
		const result = await exchange('opaque-token');

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('refuses another subject token type', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { subject_token_type: 'urn:ietf:params:oauth:token-type:id_token' },
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('accepts a request for an access token', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { requested_token_type: 'urn:ietf:params:oauth:token-type:access_token' },
		});

		expect(result.status).toBe(200);
	});

	it('refuses to issue another token type', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { requested_token_type: 'urn:ietf:params:oauth:token-type:refresh_token' },
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('refuses a requested scope, since the token has the wiki token grants', async () => {
		const result = await exchange(await wikiAccessToken(), { extra: { scope: 'basic' } });

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_scope' } });
	});

	it('refuses delegation to an actor', async () => {
		const result = await exchange(await wikiAccessToken(), { extra: { actor_token: 'actor' } });

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_request' } });
	});

	it('refuses a resource naming another server', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { resource: 'https://other.example/mcp' },
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_target' } });
	});

	it('refuses an audience naming another server', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { audience: 'https://other.example/mcp' },
		});

		expect(result).toMatchObject({ status: 400, body: { error: 'invalid_target' } });
	});

	it('accepts the resource as the protected-resource document spells it', async () => {
		const result = await exchange(await wikiAccessToken(), {
			extra: { resource: 'https://wiki.example/mcp/' },
		});

		expect(result.status).toBe(200);
	});
});
