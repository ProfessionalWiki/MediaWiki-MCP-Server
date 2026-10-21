import type { WikiConfig } from '../config/loadConfig.ts';
import type { WikiRegistry } from './wikiRegistry.ts';
import { getRequestWiki } from '../runtime/requestContext.ts';

export interface ActiveWiki {
	// The request scope's wiki, else the default. A tool reads its call's wiki from `ctx.wiki`.
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
