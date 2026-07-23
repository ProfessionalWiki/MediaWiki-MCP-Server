import type { WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from './wikiRegistry.js';
import { getRequestWiki } from '../runtime/requestContext.js';

export interface ActiveWiki {
	// The wiki for the current call: the request-context wiki, else the default.
	get(): { key: string; config: Readonly<WikiConfig> };
	// The configured default wiki key (used to resolve calls with no `wiki` arg).
	getDefaultKey(): string;
}

export class ActiveWikiImpl implements ActiveWiki {
	public constructor(
		private readonly defaultKey: string,
		private readonly registry: WikiRegistry,
	) {}

	public get(): { key: string; config: Readonly<WikiConfig> } {
		const key = getRequestWiki() ?? this.defaultKey;
		const config = this.registry.get(key);
		if (!config) {
			throw new Error(`Wiki "${key}" not found in registry`);
		}
		return { key, config };
	}

	public getDefaultKey(): string {
		return this.defaultKey;
	}
}
