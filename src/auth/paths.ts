// src/auth/paths.ts
import * as os from 'node:os';
import * as path from 'node:path';

/**
 * Resolve the credentials file path per platform conventions.
 *
 * Precedence:
 *   1. MCP_OAUTH_CREDENTIALS_FILE env (override).
 *   2. Linux/macOS: $XDG_CONFIG_HOME/mediawiki-mcp/credentials.json
 *      → ~/.config/mediawiki-mcp/credentials.json (gh-style — credentials live
 *      under config dir even though XDG would technically prefer data dir).
 *   3. Windows: %APPDATA%\mediawiki-mcp\credentials.json.
 */
export function getCredentialsPath(): string {
	const override = process.env.MCP_OAUTH_CREDENTIALS_FILE;
	if (override && override.trim() !== '') {
		return override;
	}
	if (process.platform === 'win32') {
		const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
		return path.join(appData, 'mediawiki-mcp', 'credentials.json');
	}
	const xdg = process.env.XDG_CONFIG_HOME;
	const base = xdg && xdg.trim() !== '' ? xdg : path.join(os.homedir(), '.config');
	return path.join(base, 'mediawiki-mcp', 'credentials.json');
}
