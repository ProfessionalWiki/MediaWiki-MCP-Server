import type { WikiConfig } from '../config/loadConfig.js';
import type { WikiRegistry } from './wikiRegistry.js';

export interface WikiSelection {
	getCurrent(): { key: string; config: Readonly<WikiConfig> };
	setCurrent( key: string ): void;
	reset(): void;
}

export class WikiSelectionImpl implements WikiSelection {
	private currentKey: string;

	public constructor(
		private readonly defaultKey: string,
		private readonly registry: WikiRegistry
	) {
		this.currentKey = defaultKey;
	}

	public getCurrent(): { key: string; config: Readonly<WikiConfig> } {
		const config = this.registry.get( this.currentKey );
		if ( !config ) {
			throw new Error( `Wiki "${ this.currentKey }" not found in registry` );
		}
		return { key: this.currentKey, config };
	}

	public setCurrent( key: string ): void {
		if ( !this.registry.get( key ) ) {
			throw new Error( `Wiki "${ key }" not found in config.json` );
		}
		this.currentKey = key;
	}

	public reset(): void {
		if ( !this.registry.get( this.defaultKey ) ) {
			throw new Error( `Default wiki "${ this.defaultKey }" not found in config.json` );
		}
		this.currentKey = this.defaultKey;
	}
}
