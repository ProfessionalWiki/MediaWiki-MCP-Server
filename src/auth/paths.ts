// src/auth/paths.ts
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve an app config-dir file per platform conventions.
 *
 * Precedence:
 *   1. `override` (an env value), when non-empty.
 *   2. Linux/macOS: $XDG_CONFIG_HOME/mediawiki-mcp/<filename>
 *      → ~/.config/mediawiki-mcp/<filename> (gh-style — credentials live under the
 *      config dir even though XDG would technically prefer the data dir).
 *   3. Windows: %APPDATA%\mediawiki-mcp\<filename>.
 */
function mcpConfigFile(filename: string, override?: string): string {
	if (override && override.trim() !== '') {
		return override;
	}
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'mediawiki-mcp', filename);
	}
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
	return path.join(base, 'mediawiki-mcp', filename);
}

/** Path to the stdio OAuth credentials store (per-user MediaWiki tokens). */
export function getCredentialsPath(): string {
	return mcpConfigFile('credentials.json', process.env.MCP_OAUTH_CREDENTIALS_FILE);
}

/** Path to the hosted-proxy durable store (encrypted clients + upstream tokens). */
export function getProxyStorePath(): string {
	return mcpConfigFile('proxy-store.enc', process.env.MCP_OAUTH_PROXY_STORE_FILE);
}
