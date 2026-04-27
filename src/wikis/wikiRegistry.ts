import type { WikiConfig } from '../common/config.js';

export interface WikiRegistry {
	getAll(): Readonly<Record<string, WikiConfig>>;
	get( key: string ): Readonly<WikiConfig> | undefined;
	add( key: string, config: WikiConfig ): void;
	remove( key: string ): void;
	isManagementAllowed(): boolean;
}
