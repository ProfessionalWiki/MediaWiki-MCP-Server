import { afterEach, describe, expect, it, vi } from 'vitest';
import { Mwn, type MwnOptions } from 'mwn';
import { MwnProviderImpl, type MwnProvider } from '../../src/wikis/mwnProvider.ts';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import type { runExecSecret } from '../../src/wikis/execSecret.ts';
import { CredentialResolutionError } from '../../src/errors/credentialResolutionError.ts';
import { USER_AGENT } from '../../src/runtime/constants.ts';
import { withRequestContext, withRequestFields } from '../../src/runtime/requestContext.ts';
import { createAppState } from '../../src/wikis/state.ts';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}.example.com`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

/** A request as mwn hands it to its HTTP layer: a query as a GET, anything else as a POST. */
interface RawRequest {
	params?: Record<string, string>;
	data?: string;
	headers?: Record<string, string>;
	signal?: AbortSignal;
}

/** A request as the wiki receives it. */
interface SentRequest {
	params: URLSearchParams;
	authorization?: string;
	signal?: AbortSignal;
}

function asSent(request: RawRequest): SentRequest {
	return {
		params: new URLSearchParams(request.data ?? request.params),
		authorization: request.headers?.Authorization,
		signal: request.signal,
	};
}

// Every part of a successful sign-in in one body, so it answers each request
// an anonymous, token or bot-password sign-in makes: mwn reads only the part it
// asked for.
const SIGNED_IN = {
	login: { result: 'Success', lgusername: 'Bot' },
	query: {
		tokens: { logintoken: 'login-token', csrftoken: 'csrf-token' },
		general: { legaltitlechars: ' A-Za-z0-9' },
		namespaces: { '0': { id: 0, name: '', canonical: '' } },
		namespacealiases: [],
		userinfo: { rights: [] },
	},
};

const REFUSED = { error: { code: 'internal_api_error_DBQueryError', info: 'transient' } };

interface FakeWikis {
	createMwn: (options: MwnOptions) => Mwn;
	/** The options of each Mwn the provider created: one per sign-in. */
	signIns: MwnOptions[];
	/** Every request the wikis received, in order. */
	requests: SentRequest[];
}

// Each Mwn the provider creates is a real one with only its HTTP layer stubbed,
// so mwn's own sign-in runs. The n-th sign-in is answered with the n-th of
// `answers`, the last repeating; with none given, every sign-in succeeds.
function fakeWikis(...answers: object[]): FakeWikis {
	const signIns: MwnOptions[] = [];
	const requests: SentRequest[] = [];
	return {
		signIns,
		requests,
		createMwn: (options) => {
			const answer = answers[Math.min(signIns.length, answers.length - 1)] ?? SIGNED_IN;
			signIns.push(options);
			const mwn = new Mwn(options);
			vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: RawRequest) => {
				requests.push(asSent(request));
				return { data: answer };
			}) as never);
			return mwn;
		},
	};
}

const noCommand: typeof runExecSecret = async () => {
	throw new Error('A credential command ran');
};

function providerOn(
	wikis: FakeWikis,
	setup: {
		configs: Record<string, WikiConfig>;
		runtimeToken?: string;
		command?: typeof runExecSecret;
	},
): MwnProvider {
	return new MwnProviderImpl(
		new WikiRegistryImpl(setup.configs, true),
		() => setup.runtimeToken,
		wikis.createMwn,
		setup.command ?? noCommand,
	);
}

// What the wiki receives for a read made through the session the provider hands out.
async function readThrough(
	wikis: FakeWikis,
	provider: MwnProvider,
	key: string,
): Promise<SentRequest | undefined> {
	const mwn = await provider.get(key);
	await mwn.request({ action: 'query', meta: 'siteinfo' });
	return wikis.requests.at(-1);
}

const BOT_PASSWORD = { username: 'Bot@MCP', password: 'secret' };

describe('MwnProviderImpl', () => {
	it('signs in to a wiki once, however often it is asked for', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') } });

		await provider.get('a');
		await provider.get('a');

		expect(wikis.signIns).toHaveLength(1);
	});

	it('signs in to each wiki on its own', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a'), b: sample('b') } });

		await provider.get('a');
		await provider.get('b');

		expect(wikis.signIns.map((options) => options.apiUrl)).toEqual([
			'https://a.example.com/w/api.php',
			'https://b.example.com/w/api.php',
		]);
	});

	it('signs in afresh on every call when a runtime token is set', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') }, runtimeToken: 'TOKEN' });

		await provider.get('a');
		await provider.get('a');

		expect(wikis.signIns).toHaveLength(2);
	});

	it('invalidate makes only that wiki sign in again', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a'), b: sample('b') } });

		await provider.get('a');
		await provider.get('b');
		provider.invalidate('a');
		await provider.get('a');
		await provider.get('b');

		expect(wikis.signIns.map((options) => options.apiUrl)).toEqual([
			'https://a.example.com/w/api.php',
			'https://b.example.com/w/api.php',
			'https://a.example.com/w/api.php',
		]);
	});

	it('throws when wiki key is unknown', async () => {
		const provider = providerOn(fakeWikis(), { configs: {} });

		await expect(provider.get('missing')).rejects.toThrow(/not found/);
	});

	it('signs in again on the next call after a failed sign-in', async () => {
		const wikis = fakeWikis(REFUSED, SIGNED_IN);
		const provider = providerOn(wikis, { configs: { a: sample('a') } });

		await expect(provider.get('a')).rejects.toThrow(/transient/);
		await provider.get('a');

		expect(wikis.signIns).toHaveLength(2);
	});

	it('identifies itself to the wiki with the server User-Agent', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') } });

		await provider.get('a');

		expect(wikis.signIns[0]?.userAgent).toBe(USER_AGENT);
	});

	it('signs in with the OAuth 2 token from config', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, {
			configs: { a: { ...sample('a'), token: 'config-token' } },
		});

		await provider.get('a');

		expect(new Set(wikis.requests.map((request) => request.authorization))).toEqual(
			new Set(['Bearer config-token']),
		);
	});

	it('runtime token wins over config token', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, {
			configs: { a: { ...sample('a'), token: 'config-token' } },
			runtimeToken: 'runtime-token',
		});

		await provider.get('a');

		expect(new Set(wikis.requests.map((request) => request.authorization))).toEqual(
			new Set(['Bearer runtime-token']),
		);
	});

	// Built as the server builds it, so the wiring between the request scope and
	// the provider is what is tested. Its Mwn instances are created there too, so
	// their HTTP layer is stubbed on the class.
	describe("a request's token", () => {
		afterEach(() => {
			vi.restoreAllMocks();
		});

		function authorizationsSent(): (string | undefined)[] {
			const authorizations: (string | undefined)[] = [];
			vi.spyOn(Mwn.prototype, 'rawRequest').mockImplementation((async (request: RawRequest) => {
				authorizations.push(asSent(request).authorization);
				return { data: SIGNED_IN };
			}) as never);
			return authorizations;
		}

		function providerFor(...keys: string[]): MwnProvider {
			return createAppState({
				defaultWiki: keys[0],
				wikis: Object.fromEntries(keys.map((key) => [key, sample(key)])),
				uploadDirs: [],
			}).mwnProvider;
		}

		it('is sent to the wiki it was issued for', async () => {
			const authorizations = authorizationsSent();
			const provider = providerFor('home', 'added');

			await withRequestContext({ value: 'USER-TOKEN', wikiKey: 'home' }, () =>
				provider.get('home'),
			);

			expect(authorizations).toContain('Bearer USER-TOKEN');
		});

		it('is not sent to a wiki it was not issued for', async () => {
			const authorizations = authorizationsSent();
			const provider = providerFor('home', 'added');

			await withRequestContext({ value: 'USER-TOKEN', wikiKey: 'home' }, () =>
				provider.get('added'),
			);

			expect(authorizations).not.toHaveLength(0);
			expect(authorizations).not.toContain('Bearer USER-TOKEN');
		});
	});

	it('asserts the user on reads with a bot password, so mwn logs in again on session loss', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: { ...sample('a'), ...BOT_PASSWORD } } });

		const read = await readThrough(wikis, provider, 'a');

		expect(read?.params.get('assert')).toBe('user');
	});

	it('does not assert the user on reads with an OAuth 2 token', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, {
			configs: { a: { ...sample('a'), token: 'config-token' } },
		});

		const read = await readThrough(wikis, provider, 'a');

		expect(read?.params.has('assert')).toBe(false);
	});

	it('does not assert the user on anonymous reads', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') } });

		const read = await readThrough(wikis, provider, 'a');

		expect(read?.params.has('assert')).toBe(false);
	});

	it('does not log in when a token is configured', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, {
			configs: { a: { ...sample('a'), token: 'config-token', ...BOT_PASSWORD } },
		});

		await provider.get('a');

		expect(wikis.requests.map((request) => request.params.get('action'))).not.toContain('login');
	});

	it('logs in when a bot password is configured', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: { ...sample('a'), ...BOT_PASSWORD } } });

		await provider.get('a');

		const login = wikis.requests.find((request) => request.params.get('action') === 'login');
		expect(login?.params.get('lgname')).toBe('Bot@MCP');
		expect(login?.params.get('lgpassword')).toBe('secret');
	});

	it('only reads site info when the wiki has no credentials', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') } });

		await provider.get('a');

		expect(wikis.requests.map((request) => request.params.get('meta'))).toEqual(['siteinfo']);
		expect(wikis.requests[0]?.authorization).toBeUndefined();
	});

	it('bounds the sign-in that reaching a wiki for the first time performs', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: { ...sample('a'), ...BOT_PASSWORD } } });

		await provider.get('a');

		// Three round-trips that each fund a fresh retry ladder, which `Mwn.init`
		// left carrying no signal at all.
		expect(wikis.requests.map((request) => request.signal)).not.toContain(undefined);
	});

	it('keeps a shared sign-in alive when the caller that triggered it cancels', async () => {
		const wikis = fakeWikis();
		const provider = providerOn(wikis, { configs: { a: sample('a') } });
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, () => provider.get('a'));
		controller.abort();

		// Cached and handed to every concurrent caller, so tying it to the first
		// arrival's cancellation would fail the rest.
		expect(wikis.requests[0]?.signal?.aborted).toBe(false);
	});

	describe('lazy exec-backed credentials', () => {
		const execWiki = (name: string): WikiConfig => ({
			...sample(name),
			token: { exec: { command: 'op', args: ['read', 'x'] } },
		});

		it('runs the exec command once and reuses its value when the wiki signs in again', async () => {
			const command = vi.fn<typeof runExecSecret>().mockResolvedValue('exec-token');
			const wikis = fakeWikis();
			const provider = providerOn(wikis, { configs: { a: execWiki('a') }, command });

			await provider.get('a');
			provider.invalidate('a');
			await provider.get('a');

			expect(command).toHaveBeenCalledOnce();
			expect(new Set(wikis.requests.map((request) => request.authorization))).toEqual(
				new Set(['Bearer exec-token']),
			);
		});

		it('never runs the exec command for a wiki that is not used', async () => {
			const command = vi.fn<typeof runExecSecret>().mockResolvedValue('exec-token');
			const provider = providerOn(fakeWikis(), {
				configs: { a: sample('a'), b: execWiki('b') },
				command,
			});

			await provider.get('a');

			expect(command).not.toHaveBeenCalled();
		});

		it('surfaces a failing exec command as a CredentialResolutionError', async () => {
			const command = vi
				.fn<typeof runExecSecret>()
				.mockRejectedValue(
					new CredentialResolutionError('Could not resolve the "token" credential for wiki "a"'),
				);
			const provider = providerOn(fakeWikis(), { configs: { a: execWiki('a') }, command });

			await expect(provider.get('a')).rejects.toBeInstanceOf(CredentialResolutionError);
		});

		it('does not resolve config secrets when a runtime token is present', async () => {
			const command = vi.fn<typeof runExecSecret>().mockResolvedValue('exec-token');
			const provider = providerOn(fakeWikis(), {
				configs: { a: execWiki('a') },
				runtimeToken: 'runtime-token',
				command,
			});

			await provider.get('a');

			expect(command).not.toHaveBeenCalled();
		});

		it('retries a failing exec command on the next call', async () => {
			const command = vi
				.fn<typeof runExecSecret>()
				.mockRejectedValueOnce(new CredentialResolutionError('transient'))
				.mockResolvedValueOnce('exec-token');
			const provider = providerOn(fakeWikis(), { configs: { a: execWiki('a') }, command });

			await expect(provider.get('a')).rejects.toBeInstanceOf(CredentialResolutionError);
			await provider.get('a');

			expect(command).toHaveBeenCalledTimes(2);
		});
	});
});
