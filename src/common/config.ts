interface AppConfig {
	WIKI_SERVER: string;
	ARTICLE_PATH: string;
	SCRIPT_PATH: string;
	OAUTH_TOKEN?: string;
}

// TODO: Need better handling for OAUTH_TOKEN since it will be different for each wiki.
const defaultConfig: AppConfig = {
	WIKI_SERVER: process.env.WIKI_SERVER || 'https://en.wikipedia.org',
	ARTICLE_PATH: process.env.ARTICLE_PATH || '/wiki',
	SCRIPT_PATH: process.env.SCRIPT_PATH || '/w',
	OAUTH_TOKEN: process.env.OAUTH_TOKEN || undefined
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
export const OAUTH_TOKEN = (): string|undefined => {
	const token = getConfig().OAUTH_TOKEN;
	return isTokenValid( token ) ? token : undefined;
};

function isTokenValid( token: string | undefined ): boolean {
	return token !== undefined && token !== null && token !== '';
}
