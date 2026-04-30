// tests/auth/paths.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as path from 'node:path';
import { getCredentialsPath } from '../../src/auth/paths.js';

afterEach(() => {
	vi.unstubAllEnvs();
	vi.restoreAllMocks();
	// Restore platform in case a test changed it
	Object.defineProperty(process, 'platform', { value: process.platform, configurable: true });
});

describe('getCredentialsPath', () => {
	it('returns MCP_OAUTH_CREDENTIALS_FILE verbatim when set', () => {
		vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', '/tmp/custom/creds.json');
		expect(getCredentialsPath()).toBe('/tmp/custom/creds.json');
	});
	it('uses XDG_CONFIG_HOME on Linux/macOS when set', () => {
		vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', '');
		vi.stubEnv('XDG_CONFIG_HOME', '/tmp/xdg');
		vi.stubEnv('APPDATA', '');
		Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
		expect(getCredentialsPath()).toBe(path.join('/tmp/xdg', 'mediawiki-mcp', 'credentials.json'));
	});
	it('falls back to ~/.config on Linux/macOS when XDG unset', () => {
		vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', '');
		vi.stubEnv('XDG_CONFIG_HOME', '');
		vi.stubEnv('HOME', '/home/u');
		Object.defineProperty(process, 'platform', { value: 'darwin', configurable: true });
		expect(getCredentialsPath()).toBe(
			path.join('/home/u', '.config', 'mediawiki-mcp', 'credentials.json'),
		);
	});
	it('uses %APPDATA% on win32', () => {
		vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', '');
		vi.stubEnv('APPDATA', 'C:\\Users\\u\\AppData\\Roaming');
		Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
		expect(getCredentialsPath()).toBe(
			path.join('C:\\Users\\u\\AppData\\Roaming', 'mediawiki-mcp', 'credentials.json'),
		);
	});
});
