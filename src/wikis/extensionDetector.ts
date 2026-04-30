import { makeApiRequest } from '../transport/httpFetch.js';
import type { WikiRegistry } from './wikiRegistry.js';
import { errorMessage } from '../errors/isErrnoException.js';
import { logger } from '../runtime/logger.js';

const TTL_SUCCESS_MS = 60 * 60 * 1000; // 1 hour
const TTL_FAILURE_MS = 60 * 1000; // 60 seconds

export interface ExtensionDetector {
	has(wikiKey: string, extensionName: string): Promise<boolean>;
	invalidate(wikiKey: string): void;
}

interface ExtensionsResponse {
	query?: { extensions?: { name?: string }[] };
}

type CacheEntry =
	| { kind: 'success'; extensions: Set<string>; expiresAt: number }
	| { kind: 'failed'; expiresAt: number };

export class ExtensionDetectorImpl implements ExtensionDetector {
	private readonly cache = new Map<string, CacheEntry>();
	private readonly inflight = new Map<string, Promise<CacheEntry>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly now: () => number = () => Date.now(),
	) {}

	public async has(wikiKey: string, extensionName: string): Promise<boolean> {
		const entry = await this.resolveEntry(wikiKey);
		if (entry.kind === 'failed') {
			return false;
		}
		return entry.extensions.has(extensionName);
	}

	public invalidate(wikiKey: string): void {
		this.cache.delete(wikiKey);
	}

	private async resolveEntry(wikiKey: string): Promise<CacheEntry> {
		const cached = this.cache.get(wikiKey);
		if (cached && cached.expiresAt > this.now()) {
			return cached;
		}

		const inflight = this.inflight.get(wikiKey);
		if (inflight) {
			return inflight;
		}

		const probe = this.probe(wikiKey).finally(() => {
			this.inflight.delete(wikiKey);
		});
		this.inflight.set(wikiKey, probe);
		return probe;
	}

	private async probe(wikiKey: string): Promise<CacheEntry> {
		const config = this.wikis.get(wikiKey);
		if (!config) {
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}

		const apiUrl = `${config.server}${config.scriptpath}/api.php`;
		try {
			const data = await makeApiRequest<ExtensionsResponse>(apiUrl, {
				action: 'query',
				meta: 'siteinfo',
				siprop: 'extensions',
				format: 'json',
			});
			const list = data.query?.extensions;
			if (!Array.isArray(list)) {
				throw new Error('Malformed siteinfo extensions response');
			}
			const names = new Set<string>();
			for (const ext of list) {
				if (typeof ext.name === 'string' && ext.name !== '') {
					names.add(ext.name);
				}
			}
			const entry: CacheEntry = {
				kind: 'success',
				extensions: names,
				expiresAt: this.now() + TTL_SUCCESS_MS,
			};
			this.cache.set(wikiKey, entry);
			return entry;
		} catch (error) {
			logger.warning('Extension probe failed', {
				wikiKey,
				error: errorMessage(error),
			});
			const failed: CacheEntry = { kind: 'failed', expiresAt: this.now() + TTL_FAILURE_MS };
			this.cache.set(wikiKey, failed);
			return failed;
		}
	}
}
