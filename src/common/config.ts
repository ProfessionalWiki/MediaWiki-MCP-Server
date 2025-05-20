interface AppConfig {
	WIKI_SERVER: string;
	ARTICLE_PATH: string;
	SCRIPT_PATH: string;
}

const defaultConfig: AppConfig = {
	WIKI_SERVER: 'https://en.wikipedia.org',
	ARTICLE_PATH: '/wiki',
	SCRIPT_PATH: '/w'
};

let currentConfig: AppConfig = { ...defaultConfig };

export function getConfig(): Readonly<AppConfig> {
	return { ...currentConfig }; // Return a copy to prevent direct external mutation
}

export function updateConfig( newConfig: Partial<AppConfig> ): void {
	const effectiveNewConfig = { ...newConfig };

	// If WIKI_SERVER is being updated, and ARTICLE_PATH/SCRIPT_PATH are not explicitly provided,
	// reset them to their global defaults from defaultConfig.
	if ( newConfig.WIKI_SERVER && newConfig.WIKI_SERVER !== currentConfig.WIKI_SERVER ) {
		if ( newConfig.ARTICLE_PATH === undefined ) {
			effectiveNewConfig.ARTICLE_PATH = defaultConfig.ARTICLE_PATH;
		}
		if ( newConfig.SCRIPT_PATH === undefined ) {
			effectiveNewConfig.SCRIPT_PATH = defaultConfig.SCRIPT_PATH;
		}
	}
	currentConfig = { ...currentConfig, ...effectiveNewConfig };
}

export function resetConfig(): void {
	currentConfig = { ...defaultConfig };
}

export const WIKI_SERVER = (): string => getConfig().WIKI_SERVER;
export const ARTICLE_PATH = (): string => getConfig().ARTICLE_PATH;
export const SCRIPT_PATH = (): string => getConfig().SCRIPT_PATH;
