import { type StderrWriteSpy } from '../helpers/stderrSpy.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import { execFileSync } from 'child_process';

vi.mock('fs');
vi.mock('child_process');

const setConfigFile = (cfg: unknown) => {
	vi.mocked(fs.existsSync).mockReturnValue(true);
	vi.mocked(fs.readFileSync).mockReturnValue(JSON.stringify(cfg));
};

const baseWiki = {
	sitename: 'Test Wiki',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	private: false,
};

describe('loadConfigFromFile', () => {
	let stderrSpy: StderrWriteSpy;

	beforeEach(() => {
		vi.resetModules();
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
	});

	describe('no config file', () => {
		it('returns defaultConfig when config.json does not exist', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const { loadConfigFromFile, defaultConfig } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile()).toEqual(defaultConfig);
		});

		it('warns when CONFIG points at a missing file', async () => {
			vi.stubEnv('CONFIG', '/etc/mediawiki-mcp/absent.json');
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const { loadConfigFromFile, defaultConfig } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile()).toEqual(defaultConfig);

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).toContain('/etc/mediawiki-mcp/absent.json');
			expect(output).toContain('does not exist');
		});

		it('does not warn when CONFIG is empty and config.json does not exist', async () => {
			vi.stubEnv('CONFIG', '');
			vi.mocked(fs.existsSync).mockReturnValue(false);
			const { loadConfigFromFile, defaultConfig } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile()).toEqual(defaultConfig);

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).not.toContain('does not exist');
		});
	});

	describe('${VAR} substitution in secret fields', () => {
		it('resolves ${VAR} when the variable is set', async () => {
			vi.stubEnv('MY_TOKEN', 'resolved-token');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${MY_TOKEN}' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.token).toBe('resolved-token');
		});

		it('throws when ${VAR} in a secret field is not set', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${MISSING_VAR}' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(
				'Config error: environment variable "MISSING_VAR" referenced by wikis.w.token is not set',
			);
		});

		it('throws for username and password too', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, username: '${NOPE_U}' } },
			});
			const { loadConfigFromFile: loadU } = await import('../../src/config/loadConfig.ts');
			expect(() => loadU()).toThrow('referenced by wikis.w.username');

			vi.resetModules();
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, password: '${NOPE_P}' } },
			});
			const { loadConfigFromFile: loadP } = await import('../../src/config/loadConfig.ts');
			expect(() => loadP()).toThrow('referenced by wikis.w.password');
		});

		it('leaves unresolved ${VAR} in non-secret fields as-is', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, sitename: '${NOT_SET}', token: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.sitename).toBe('${NOT_SET}');
		});
	});

	describe('allowWikiManagement', () => {
		it('preserves allowWikiManagement: false through the loader', async () => {
			setConfigFile({
				allowWikiManagement: false,
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().allowWikiManagement).toBe(false);
		});
	});

	describe('per-wiki readOnly', () => {
		it('preserves readOnly: true through the loader', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, readOnly: true } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.readOnly).toBe(true);
		});

		it('preserves readOnly: false through the loader', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, readOnly: false } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.readOnly).toBe(false);
		});

		it('leaves readOnly undefined when the field is absent', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.readOnly).toBeUndefined();
		});

		it('throws when readOnly is not a boolean', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, readOnly: 'yes' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(
				'Config error: wikis.w.readOnly must be a boolean',
			);
		});
	});

	describe('field types', () => {
		const loadWikiWith = async (field: string, value: unknown) => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, [field]: value } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			return loadConfigFromFile;
		};

		it.each(['private', 'readOnly', 'attributeEdits'])(
			'throws when %s is a quoted boolean',
			async (field) => {
				const load = await loadWikiWith(field, 'true');
				expect(load).toThrow(`Config error: wikis.w.${field} must be a boolean`);
			},
		);

		it('points at the quoting when a boolean is quoted', async () => {
			const load = await loadWikiWith('readOnly', 'true');
			expect(load).toThrow('Remove the quotes');
		});

		it('throws when a string field holds a number', async () => {
			const load = await loadWikiWith('server', 42);
			expect(load).toThrow('Config error: wikis.w.server must be a string');
		});

		it('throws when oauth2CallbackPort is a quoted number', async () => {
			const load = await loadWikiWith('oauth2CallbackPort', '8080');
			expect(load).toThrow('Config error: wikis.w.oauth2CallbackPort must be a number');
		});

		it('throws when tags holds a non-string entry', async () => {
			const load = await loadWikiWith('tags', ['mcp', 7]);
			expect(load).toThrow(
				'Config error: wikis.w.tags must be a string or an array of strings, but is an array with a non-string entry.',
			);
		});

		it('throws when a boolean field is given as an env var reference', async () => {
			vi.stubEnv('MCP_READ_ONLY', 'true');
			const load = await loadWikiWith('readOnly', '${MCP_READ_ONLY}');
			expect(load).toThrow('Config error: wikis.w.readOnly must be a boolean');
		});

		it('accepts tags as an array of strings', async () => {
			const load = await loadWikiWith('tags', ['mcp', 'automated']);
			expect(load().wikis.w.tags).toEqual(['mcp', 'automated']);
		});

		it('throws when a boolean field is null', async () => {
			const load = await loadWikiWith('readOnly', null);
			expect(load).toThrow('Config error: wikis.w.readOnly must be a boolean');
		});

		it('accepts null in a field whose declared type allows it', async () => {
			const load = await loadWikiWith('publicServer', null);
			const wiki = load().wikis.w;
			expect(wiki.sitename).toBe('Test Wiki');
			expect(wiki.publicServer).toBeNull();
		});

		it('throws when allowWikiManagement is a quoted boolean', async () => {
			setConfigFile({
				allowWikiManagement: 'false',
				defaultWiki: 'w',
				wikis: { w: baseWiki },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile).toThrow('Config error: allowWikiManagement must be a boolean');
		});

		it('throws when defaultWiki is not a string', async () => {
			setConfigFile({ defaultWiki: 7, wikis: { w: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile).toThrow('Config error: defaultWiki must be a string');
		});

		it('throws when wikis is not an object', async () => {
			setConfigFile({ defaultWiki: 'w', wikis: [baseWiki] });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile).toThrow('Config error: wikis must be an object');
		});
	});

	describe('wiki keys', () => {
		// Percent-encoding carries these through to a reachable resource URI.
		it.each(['a/b', 'a?b', 'a#b', 'my wiki'])('accepts a wiki key containing %j', async (key) => {
			setConfigFile({ defaultWiki: key, wikis: { [key]: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(Object.keys(loadConfigFromFile().wikis)).toEqual([key]);
		});

		it('throws when a wiki key begins with the resource URI prefix', async () => {
			const key = 'mcp://wikis/x';
			setConfigFile({ defaultWiki: key, wikis: { [key]: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/cannot start with/);
		});

		it('throws when a wiki key is empty', async () => {
			setConfigFile({ defaultWiki: '', wikis: { '': baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/cannot be empty/);
		});

		it('throws when a wiki key is not valid Unicode', async () => {
			const key = 'a\ud800b';
			setConfigFile({ defaultWiki: key, wikis: { [key]: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/not valid Unicode/);
		});

		it('accepts a host:port key', async () => {
			setConfigFile({ defaultWiki: 'localhost:8080', wikis: { 'localhost:8080': baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(Object.keys(loadConfigFromFile().wikis)).toEqual(['localhost:8080']);
		});
	});

	describe('MCP_OAUTH2_CLIENT_ID override', () => {
		it('overrides the default wiki oauth2ClientId from the environment', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_ID', 'env-client-id');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientId).toBe('env-client-id');
		});

		it('sets oauth2ClientId on the default wiki when config has none', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_ID', 'env-client-id');
			setConfigFile({ defaultWiki: 'w', wikis: { w: { ...baseWiki } } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientId).toBe('env-client-id');
		});

		it('leaves the configured oauth2ClientId untouched when the env var is unset', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientId).toBe('config-id');
		});

		it('ignores a blank env value (does not blank out a configured id)', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_ID', '   ');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientId).toBe('config-id');
		});

		it('only affects the default wiki', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_ID', 'env-client-id');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki }, other: { ...baseWiki, oauth2ClientId: 'other-id' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			const cfg = loadConfigFromFile();
			expect(cfg.wikis.w.oauth2ClientId).toBe('env-client-id');
			expect(cfg.wikis.other.oauth2ClientId).toBe('other-id');
		});
	});

	describe('MCP_OAUTH2_CLIENT_SECRET override', () => {
		it('overrides the default wiki oauth2ClientSecret from the environment', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_SECRET', 'env-secret');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientSecret: 'config-secret' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientSecret).toBe('env-secret');
		});

		it('sets oauth2ClientSecret on the default wiki when config has none', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_SECRET', 'env-secret');
			setConfigFile({ defaultWiki: 'w', wikis: { w: { ...baseWiki } } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientSecret).toBe('env-secret');
		});

		it('ignores a blank env value (does not blank out a configured secret)', async () => {
			vi.stubEnv('MCP_OAUTH2_CLIENT_SECRET', '   ');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientSecret: 'config-secret' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientSecret).toBe('config-secret');
		});

		it('leaves an absent secret undefined (public consumer)', async () => {
			setConfigFile({ defaultWiki: 'w', wikis: { w: { ...baseWiki } } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.oauth2ClientSecret).toBeUndefined();
		});
	});

	describe('passthrough cases', () => {
		it('passes through null secret fields unchanged', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.token).toBeNull();
		});

		it('passes through plaintext secrets unchanged (warning comes in a later task)', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: 'plain-secret' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.token).toBe('plain-secret');
		});
	});

	describe('plaintext warnings', () => {
		it('warns when a secret field is a plaintext literal', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: 'plain-secret-SENTINEL' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).toContain('wikis.w.token');
			expect(output).toContain('plaintext credential');
			expect(output).not.toContain('plain-secret-SENTINEL');
		});

		it('does not warn for resolved ${VAR} secrets', async () => {
			vi.stubEnv('SAFE_TOKEN', 'resolved');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '${SAFE_TOKEN}' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).not.toContain('plaintext credential');
		});

		it('does not warn for null secrets', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, username: null, password: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).not.toContain('plaintext credential');
		});

		it('does not warn for empty-string secrets', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: '' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).not.toContain('plaintext credential');
		});

		it('warns once per offending field across multiple wikis', async () => {
			setConfigFile({
				defaultWiki: 'a',
				wikis: {
					a: { ...baseWiki, token: 'xxxxxxx', password: 'yyyyyyy' },
					b: { ...baseWiki, username: 'zzzzzzz' },
				},
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();

			const output = stderrSpy.mock.calls.map((c) => String(c[0])).join('');
			expect(output).toContain('wikis.a.token');
			expect(output).toContain('wikis.a.password');
			expect(output).toContain('wikis.b.username');
		});
	});

	describe('uploadDirs', () => {
		beforeEach(() => {
			vi.mocked(fs.realpathSync).mockImplementation((p) => String(p));
		});

		it('defaults to an empty array when neither source is set', async () => {
			setConfigFile({ defaultWiki: 'w', wikis: { w: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual([]);
		});

		it('honours MCP_UPLOAD_DIRS even when no config.json exists', async () => {
			vi.mocked(fs.existsSync).mockReturnValue(false);
			vi.stubEnv('MCP_UPLOAD_DIRS', '/x');
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual(['/x']);
		});

		it('parses config.json uploadDirs and canonicalises each entry', async () => {
			vi.mocked(fs.realpathSync).mockImplementation((p) => {
				if (p === '/home/user/uploads') {
					return '/var/lib/uploads';
				}
				return String(p);
			});
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: baseWiki },
				uploadDirs: ['/home/user/uploads', '/tmp/incoming'],
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual(['/var/lib/uploads', '/tmp/incoming']);
		});

		it('parses MCP_UPLOAD_DIRS env var with colon separator', async () => {
			vi.stubEnv('MCP_UPLOAD_DIRS', '/a:/b');
			setConfigFile({ defaultWiki: 'w', wikis: { w: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual(['/a', '/b']);
		});

		it('unions config.json and env-var sources, dedup after canonicalisation', async () => {
			vi.stubEnv('MCP_UPLOAD_DIRS', '/a:/b');
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: baseWiki },
				uploadDirs: ['/b', '/c'],
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual(['/a', '/b', '/c']);
		});

		it('treats empty MCP_UPLOAD_DIRS as unset', async () => {
			vi.stubEnv('MCP_UPLOAD_DIRS', '');
			setConfigFile({ defaultWiki: 'w', wikis: { w: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().uploadDirs).toEqual([]);
		});

		it('throws when uploadDirs contains a non-string', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: baseWiki },
				uploadDirs: ['/a', 42],
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/uploadDirs/);
		});

		it('throws when a config uploadDirs entry is relative', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: baseWiki },
				uploadDirs: ['relative/path'],
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/must be absolute/);
		});

		it('throws when MCP_UPLOAD_DIRS contains a relative entry', async () => {
			vi.stubEnv('MCP_UPLOAD_DIRS', '/ok:relative');
			setConfigFile({ defaultWiki: 'w', wikis: { w: baseWiki } });
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/must be absolute/);
		});

		it('throws when an entry cannot be canonicalised', async () => {
			vi.mocked(fs.realpathSync).mockImplementation((p) => {
				if (p === '/does/not/exist') {
					throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
				}
				return String(p);
			});
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: baseWiki },
				uploadDirs: ['/does/not/exist'],
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(/cannot be resolved/);
		});
	});

	describe('exec credential source', () => {
		it('returns an ExecSecret marker without running the command', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: {
					w: {
						...baseWiki,
						token: { exec: { command: 'op', args: ['read', 'op://vault/token'] } },
					},
				},
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			const token = loadConfigFromFile().wikis.w.token;
			expect(token).toEqual({ exec: { command: 'op', args: ['read', 'op://vault/token'] } });
			expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
		});

		it('normalises a missing args array to []', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'my-helper' } } } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.w.token).toEqual({
				exec: { command: 'my-helper', args: [] },
			});
		});

		it('runs no exec command at load even across multiple exec-backed wikis', async () => {
			setConfigFile({
				defaultWiki: 'a',
				wikis: {
					a: { ...baseWiki, token: { exec: { command: 'op', args: ['a'] } } },
					b: { ...baseWiki, username: { exec: { command: 'op', args: ['b'] } } },
				},
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			loadConfigFromFile();
			expect(vi.mocked(execFileSync)).not.toHaveBeenCalled();
		});

		it('throws when exec.command is missing or empty', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: '' } } } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(
				'Config error: wikis.w.token.exec.command must be a non-empty string',
			);
		});

		it('throws when exec.args is not a string array', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'op', args: [1, 2] } } } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(
				'Config error: wikis.w.token.exec.args must be an array of strings',
			);
		});

		it('throws for a malformed object in a secret field', async () => {
			setConfigFile({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { wrong: 'shape' } } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(() => loadConfigFromFile()).toThrow(
				'Config error: wikis.w.token must be a string, null, or an {exec: …} object',
			);
		});
	});

	describe('oauth2ClientId field', () => {
		it('round-trips a populated value', async () => {
			setConfigFile({
				defaultWiki: 'a',
				wikis: { a: { ...baseWiki, oauth2ClientId: 'abc123' } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.a.oauth2ClientId).toBe('abc123');
		});

		it('is undefined when omitted', async () => {
			setConfigFile({
				defaultWiki: 'a',
				wikis: { a: { ...baseWiki } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.a.oauth2ClientId).toBeUndefined();
		});

		it('preserves null verbatim', async () => {
			setConfigFile({
				defaultWiki: 'a',
				wikis: { a: { ...baseWiki, oauth2ClientId: null } },
			});
			const { loadConfigFromFile } = await import('../../src/config/loadConfig.ts');
			expect(loadConfigFromFile().wikis.a.oauth2ClientId).toBeNull();
		});
	});
});
