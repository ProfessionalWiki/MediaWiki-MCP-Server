import type { WikiConfig } from '../common/config.js';

export interface WikiSelection {
	getCurrent(): { key: string; config: Readonly<WikiConfig> };
	setCurrent( key: string ): void;
	reset(): void;
}
