import { createHash } from 'node:crypto';
import { Mwn, type MwnOptions } from 'mwn';
import { USER_AGENT } from '../runtime/constants.ts';
import type { RuntimeCredentials } from '../runtime/requestContext.ts';
import type { ExecSecret, WikiConfig } from '../config/loadConfig.ts';
import { runExecSecret } from './execSecret.ts';
import { redactAuthorizationHeader, wrapMwnErrors } from './mwnErrorSanitizer.ts';
import type { WikiRegistry } from './wikiRegistry.ts';
import type { ActiveWiki } from './activeWiki.ts';

export interface MwnProvider {
	get(wikiKey?: string): Promise<Mwn>;
	invalidate(wikiKey: string): void;
}

// How many caller-credentialed sessions are kept alive at once, across all
// wikis. Each entry is one logged-in mwn instance; the cap bounds both memory
// and how long a caller's credentials stay resident. Well past the concurrent
// distinct callers a deployment of this shape sees, and a miss costs one login,
// never a failure.
const MAX_CREDENTIAL_SESSIONS = 32;

export class MwnProviderImpl implements MwnProvider {
	// Cache the Promise, not the resolved instance, so concurrent first-calls
	// for the same wiki share a single login / getSiteInfo round-trip.
	private readonly cache = new Map<string, Promise<Mwn>>();

	// Sessions logged in with credentials the CALLER supplied, keyed per wiki and
	// credential pair. Without it every tool call would re-login: unlike a bearer,
	// which mwn just sets as a header, a bot password costs a login round-trip
	// per instance. Insertion-ordered, so the oldest entry is the one evicted.
	private readonly credentialCache = new Map<string, Promise<Mwn>>();

	// Resolved exec-backed secrets, cached per `${wikiKey} ${field}` for the
	// process lifetime. Caches the Promise so concurrent first-resolves share one
	// command run; a rejection is evicted so a transient failure can retry.
	private readonly secretCache = new Map<string, Promise<string | null>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly activeWiki: ActiveWiki,
		private readonly getRuntimeToken: () => string | undefined,
		private readonly getRuntimeCredentials: () => RuntimeCredentials | undefined = () => undefined,
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
			({ key, config } = this.activeWiki.get());
		}
		return this.getInstance(key, config);
	}

	private async getInstance(key: string, config: Readonly<WikiConfig>): Promise<Mwn> {
		const runtimeToken = this.getRuntimeToken();
		if (runtimeToken) {
			return this.create(key, config, runtimeToken);
		}
		// After the token and before the configured credentials: a caller acting as
		// itself outranks whatever identity the deployment would otherwise fall back
		// to, which is the whole point of accepting the header.
		const runtimeCredentials = this.getRuntimeCredentials();
		if (runtimeCredentials) {
			return this.getCredentialInstance(key, config, runtimeCredentials);
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

	private async getCredentialInstance(
		key: string,
		config: Readonly<WikiConfig>,
		credentials: RuntimeCredentials,
	): Promise<Mwn> {
		// The credentials are hashed, not concatenated verbatim: the key is held for
		// the session's lifetime and a digest is enough to tell two callers apart.
		// The wiki key stays in the clear so invalidate() can find its entries.
		const digest = createHash('sha256')
			.update(`${credentials.username}\u0000${credentials.password}`)
			.digest('hex');
		const cacheKey = `${key}\u0000${digest}`;
		let pending = this.credentialCache.get(cacheKey);
		if (!pending) {
			if (this.credentialCache.size >= MAX_CREDENTIAL_SESSIONS) {
				// Insertion order, so this is the least recently CREATED session, which
				// for a login that never expires is as good a victim as any. Dropping a
				// live session costs its next caller one login and nothing else.
				const oldest = this.credentialCache.keys().next();
				if (!oldest.done) {
					this.credentialCache.delete(oldest.value);
				}
			}
			pending = this.create(key, config, undefined, credentials);
			this.credentialCache.set(cacheKey, pending);
			// A failed login must not be cached, or a caller that fixes its password
			// would keep being handed the original failure.
			pending.catch(() => {
				this.credentialCache.delete(cacheKey);
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
		// Caller-credentialed sessions for the same wiki go too: they hold an
		// apiUrl built from the config this call is retiring.
		for (const cacheKey of this.credentialCache.keys()) {
			if (cacheKey.startsWith(`${key}\u0000`)) {
				this.credentialCache.delete(cacheKey);
			}
		}
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
		runtimeCredentials?: RuntimeCredentials,
	): Promise<Mwn> {
		const { server, scriptpath } = config;

		// Either kind of caller-supplied identity wins, so config secrets are not
		// even resolved in those paths. Otherwise resolve the config token; only if
		// there is no token at all do we resolve the bot-password pair.
		const runtimeAuth = runtimeToken !== undefined || runtimeCredentials !== undefined;
		const token = runtimeAuth ? undefined : await this.resolveSecret(key, 'token', config.token);
		const effectiveToken: string | undefined = runtimeToken ?? token ?? undefined;

		let username: string | null = null;
		let password: string | null = null;
		if (runtimeCredentials) {
			({ username, password } = runtimeCredentials);
		} else if (!effectiveToken) {
			username = await this.resolveSecret(key, 'username', config.username);
			password = await this.resolveSecret(key, 'password', config.password);
		}

		const options: MwnOptions = {
			apiUrl: `${server}${scriptpath}/api.php`,
			userAgent: USER_AGENT,
		};

		// The one secret an error must never carry back to the caller that supplied
		// it — the token, or the password of a caller-supplied bot-password pair. A
		// password read from config is left out: it is the operator's own, and this
		// argument replaces literal occurrences, so a short or common value would
		// redact unrelated text.
		const redactionSecret = effectiveToken ?? runtimeCredentials?.password;

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
			redactAuthorizationHeader(error, redactionSecret);
			throw error;
		}

		return wrapMwnErrors(instance, redactionSecret);
	}
}
