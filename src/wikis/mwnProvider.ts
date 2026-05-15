import { Mwn, type MwnOptions } from 'mwn';
import { USER_AGENT } from '../runtime/constants.js';
import type { ExecSecret, WikiConfig } from '../config/loadConfig.js';
import { runExecSecret } from './execSecret.js';
import { redactAuthorizationHeader, wrapMwnErrors } from './mwnErrorSanitizer.js';
import type { WikiRegistry } from './wikiRegistry.js';
import type { WikiSelection } from './wikiSelection.js';

export interface MwnProvider {
	get(wikiKey?: string): Promise<Mwn>;
	invalidate(wikiKey: string): void;
}

export class MwnProviderImpl implements MwnProvider {
	// Cache the Promise, not the resolved instance, so concurrent first-calls
	// for the same wiki share a single login / getSiteInfo round-trip.
	private readonly cache = new Map<string, Promise<Mwn>>();

	// Resolved exec-backed secrets, cached per `${wikiKey} ${field}` for the
	// process lifetime. Caches the Promise so concurrent first-resolves share one
	// command run; a rejection is evicted so a transient failure can retry.
	private readonly secretCache = new Map<string, Promise<string | null>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly selection: WikiSelection,
		private readonly getRuntimeToken: () => string | undefined,
	) {}

	public async get(wikiKey?: string): Promise<Mwn> {
		let key: string;
		let config: Readonly<WikiConfig> | undefined;
		if (wikiKey !== undefined) {
			key = wikiKey;
			config = this.wikis.get(wikiKey);
			if (!config) {
				throw new Error(`Wiki "${wikiKey}" not found`);
			}
		} else {
			({ key, config } = this.selection.getCurrent());
		}
		return this.getInstance(key, config);
	}

	private async getInstance(key: string, config: Readonly<WikiConfig>): Promise<Mwn> {
		const runtimeToken = this.getRuntimeToken();
		if (runtimeToken) {
			return this.create(key, config, runtimeToken);
		}

		let pending = this.cache.get(key);
		if (!pending) {
			pending = this.create(key, config);
			this.cache.set(key, pending);
			// On failure, remove from cache so the next call retries rather than
			// permanently caching the rejected Promise.
			pending.catch(() => {
				this.cache.delete(key);
			});
		}
		return pending;
	}

	public invalidate(key: string): void {
		// Only the live mwn instance is dropped — e.g. after an OAuth token
		// refresh. secretCache is intentionally left intact: a config-derived
		// exec secret is stable for the process, so re-running the command
		// would be wasteful.
		this.cache.delete(key);
	}

	private async resolveSecret(
		wikiKey: string,
		field: 'token' | 'username' | 'password',
		raw: string | ExecSecret | null | undefined,
	): Promise<string | null> {
		if (raw === null || raw === undefined) {
			return null;
		}
		if (typeof raw === 'string') {
			return raw;
		}
		const cacheKey = `${wikiKey} ${field}`;
		let pending = this.secretCache.get(cacheKey);
		if (!pending) {
			pending = runExecSecret(raw, `the "${field}" credential for wiki "${wikiKey}"`);
			this.secretCache.set(cacheKey, pending);
			// Evict a rejected resolution so the next use of the wiki retries
			// rather than permanently caching a transient failure.
			pending.catch(() => {
				this.secretCache.delete(cacheKey);
			});
		}
		return pending;
	}

	private async create(
		key: string,
		config: Readonly<WikiConfig>,
		runtimeToken?: string,
	): Promise<Mwn> {
		const { server, scriptpath } = config;

		// A runtime token always wins, so config secrets are not even resolved
		// in that path. Otherwise resolve the config token; only if there is no
		// token at all do we resolve the bot-password pair.
		const token = runtimeToken ? undefined : await this.resolveSecret(key, 'token', config.token);
		const effectiveToken: string | undefined = runtimeToken ?? token ?? undefined;

		let username: string | null = null;
		let password: string | null = null;
		if (!effectiveToken) {
			username = await this.resolveSecret(key, 'username', config.username);
			password = await this.resolveSecret(key, 'password', config.password);
		}

		const options: MwnOptions = {
			apiUrl: `${server}${scriptpath}/api.php`,
			userAgent: USER_AGENT,
		};

		let instance: Mwn;
		try {
			if (effectiveToken) {
				options.OAuth2AccessToken = effectiveToken;
				instance = await Mwn.init(options);
			} else if (username && password) {
				options.username = username;
				options.password = password;
				// Force `assert=user` so MediaWiki returns `assertuserfailed` (instead of
				// silently downgrading to anonymous) once the BotPassword session expires.
				// mwn already auto-relogs in and retries on that code; without `assert`,
				// writes would fail with `permissiondenied` and no recovery would occur.
				options.defaultParams = { ...options.defaultParams, assert: 'user' };
				instance = await Mwn.init(options);
			} else {
				instance = new Mwn(options);
				await instance.getSiteInfo();
			}
		} catch (error: unknown) {
			redactAuthorizationHeader(error, effectiveToken);
			throw error;
		}

		return wrapMwnErrors(instance, effectiveToken);
	}
}
