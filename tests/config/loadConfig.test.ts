import { type StderrWriteSpy } from '../helpers/stderrSpy.ts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import {
	defaultConfig,
	loadConfigFromFile,
	parseConfig,
	type Config,
} from '../../src/config/loadConfig.ts';

const baseWiki = {
	sitename: 'Test Wiki',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	private: false,
};

// Every directory exists and is already canonical.
const canonical = (dir: string): string => dir;

function parse(
	cfg: unknown,
	env: NodeJS.ProcessEnv = {},
	realpath: (dir: string) => string = canonical,
): Config {
	return parseConfig(JSON.stringify(cfg), env, realpath);
}

let stderrSpy: StderrWriteSpy;

function stderrOutput(): string {
	return stderrSpy.mock.calls.map((c) => String(c[0])).join('');
}

beforeEach(() => {
	vi.stubEnv('MCP_LOG_LEVEL', 'debug');
	stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
});

afterEach(() => {
	vi.restoreAllMocks();
	vi.unstubAllEnvs();
});

describe('loadConfigFromFile', () => {
	const workingDirectory = process.cwd();
	let dir: string;

	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'mwmcp-config-'));
	});

	afterEach(() => {
		process.chdir(workingDirectory);
		fs.rmSync(dir, { recursive: true, force: true });
	});

	it('reads the file CONFIG points at', () => {
		const file = path.join(dir, 'wikis.json');
		fs.writeFileSync(file, JSON.stringify({ defaultWiki: 'w', wikis: { w: baseWiki } }));
		vi.stubEnv('CONFIG', file);

		expect(loadConfigFromFile()).toMatchObject({ defaultWiki: 'w', wikis: { w: baseWiki } });
	});

	it('returns defaultConfig when config.json does not exist', () => {
		vi.stubEnv('CONFIG', '');
		process.chdir(dir);

		expect(loadConfigFromFile()).toEqual(defaultConfig);
	});

	it('warns when CONFIG points at a missing file', () => {
		const missing = path.join(dir, 'absent.json');
		vi.stubEnv('CONFIG', missing);

		expect(loadConfigFromFile()).toEqual(defaultConfig);
		expect(stderrOutput()).toContain(missing);
		expect(stderrOutput()).toContain('does not exist');
	});

	it('does not warn when CONFIG is empty and config.json does not exist', () => {
		vi.stubEnv('CONFIG', '');
		process.chdir(dir);

		loadConfigFromFile();

		expect(stderrOutput()).not.toContain('does not exist');
	});

	it('honours MCP_UPLOAD_DIRS even when no config file exists', () => {
		vi.stubEnv('CONFIG', path.join(dir, 'absent.json'));
		vi.stubEnv('MCP_UPLOAD_DIRS', dir);

		expect(loadConfigFromFile().uploadDirs).toEqual([dir]);
	});
});

describe('parseConfig', () => {
	describe('${VAR} substitution in secret fields', () => {
		it('resolves ${VAR} when the variable is set', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: '${MY_TOKEN}' } } },
				{ MY_TOKEN: 'resolved-token' },
			);

			expect(config.wikis.w.token).toBe('resolved-token');
		});

		it('throws when ${VAR} in a secret field is not set', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: '${MISSING_VAR}' } } }),
			).toThrow(
				'Config error: environment variable "MISSING_VAR" referenced by wikis.w.token is not set',
			);
		});

		it('throws for username and password too', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, username: '${NOPE_U}' } } }),
			).toThrow('referenced by wikis.w.username');
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, password: '${NOPE_P}' } } }),
			).toThrow('referenced by wikis.w.password');
		});

		it('leaves unresolved ${VAR} in non-secret fields as-is', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, sitename: '${NOT_SET}', token: null } },
			});

			expect(config.wikis.w.sitename).toBe('${NOT_SET}');
		});
	});

	describe('allowWikiManagement', () => {
		it('preserves allowWikiManagement: false through the loader', () => {
			const config = parse({
				allowWikiManagement: false,
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null } },
			});

			expect(config.allowWikiManagement).toBe(false);
		});
	});

	describe('per-wiki readOnly', () => {
		it('preserves readOnly: true through the loader', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, readOnly: true } },
			});

			expect(config.wikis.w.readOnly).toBe(true);
		});

		it('preserves readOnly: false through the loader', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, readOnly: false } },
			});

			expect(config.wikis.w.readOnly).toBe(false);
		});

		it('leaves readOnly undefined when the field is absent', () => {
			const config = parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: null } } });

			expect(config.wikis.w.readOnly).toBeUndefined();
		});

		it('throws when readOnly is not a boolean', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: null, readOnly: 'yes' } } }),
			).toThrow('Config error: wikis.w.readOnly must be a boolean');
		});
	});

	describe('wiki keys', () => {
		// Percent-encoding carries these through to a reachable resource URI.
		it.each(['a/b', 'a?b', 'a#b', 'my wiki'])('accepts a wiki key containing %j', (key) => {
			const config = parse({ defaultWiki: key, wikis: { [key]: baseWiki } });

			expect(Object.keys(config.wikis)).toEqual([key]);
		});

		it('throws when a wiki key begins with the resource URI prefix', () => {
			const key = 'mcp://wikis/x';

			expect(() => parse({ defaultWiki: key, wikis: { [key]: baseWiki } })).toThrow(
				/cannot start with/,
			);
		});

		it('throws when a wiki key is empty', () => {
			expect(() => parse({ defaultWiki: '', wikis: { '': baseWiki } })).toThrow(/cannot be empty/);
		});

		it('throws when a wiki key is not valid Unicode', () => {
			const key = 'a\ud800b';

			expect(() => parse({ defaultWiki: key, wikis: { [key]: baseWiki } })).toThrow(
				/not valid Unicode/,
			);
		});

		it('accepts a host:port key', () => {
			const config = parse({
				defaultWiki: 'localhost:8080',
				wikis: { 'localhost:8080': baseWiki },
			});

			expect(Object.keys(config.wikis)).toEqual(['localhost:8080']);
		});
	});

	describe('MCP_OAUTH2_CLIENT_ID override', () => {
		it('overrides the default wiki oauth2ClientId from the environment', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } } },
				{ MCP_OAUTH2_CLIENT_ID: 'env-client-id' },
			);

			expect(config.wikis.w.oauth2ClientId).toBe('env-client-id');
		});

		it('sets oauth2ClientId on the default wiki when config has none', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki } } },
				{ MCP_OAUTH2_CLIENT_ID: 'env-client-id' },
			);

			expect(config.wikis.w.oauth2ClientId).toBe('env-client-id');
		});

		it('leaves the configured oauth2ClientId untouched when the env var is unset', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } },
			});

			expect(config.wikis.w.oauth2ClientId).toBe('config-id');
		});

		it('ignores a blank env value (does not blank out a configured id)', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, oauth2ClientId: 'config-id' } } },
				{ MCP_OAUTH2_CLIENT_ID: '   ' },
			);

			expect(config.wikis.w.oauth2ClientId).toBe('config-id');
		});

		it('only affects the default wiki', () => {
			const config = parse(
				{
					defaultWiki: 'w',
					wikis: { w: { ...baseWiki }, other: { ...baseWiki, oauth2ClientId: 'other-id' } },
				},
				{ MCP_OAUTH2_CLIENT_ID: 'env-client-id' },
			);

			expect(config.wikis.w.oauth2ClientId).toBe('env-client-id');
			expect(config.wikis.other.oauth2ClientId).toBe('other-id');
		});
	});

	describe('MCP_OAUTH2_CLIENT_SECRET override', () => {
		it('overrides the default wiki oauth2ClientSecret from the environment', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, oauth2ClientSecret: 'config-secret' } } },
				{ MCP_OAUTH2_CLIENT_SECRET: 'env-secret' },
			);

			expect(config.wikis.w.oauth2ClientSecret).toBe('env-secret');
		});

		it('sets oauth2ClientSecret on the default wiki when config has none', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki } } },
				{ MCP_OAUTH2_CLIENT_SECRET: 'env-secret' },
			);

			expect(config.wikis.w.oauth2ClientSecret).toBe('env-secret');
		});

		it('ignores a blank env value (does not blank out a configured secret)', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, oauth2ClientSecret: 'config-secret' } } },
				{ MCP_OAUTH2_CLIENT_SECRET: '   ' },
			);

			expect(config.wikis.w.oauth2ClientSecret).toBe('config-secret');
		});

		it('leaves an absent secret undefined (public consumer)', () => {
			const config = parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki } } });

			expect(config.wikis.w.oauth2ClientSecret).toBeUndefined();
		});
	});

	describe('passthrough cases', () => {
		it('passes through null secret fields unchanged', () => {
			const config = parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: null } } });

			expect(config.wikis.w.token).toBeNull();
		});

		it('passes through plaintext secrets unchanged (warning comes in a later task)', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: 'plain-secret' } },
			});

			expect(config.wikis.w.token).toBe('plain-secret');
		});
	});

	describe('plaintext warnings', () => {
		it('warns when a secret field is a plaintext literal', () => {
			parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: 'plain-secret-SENTINEL' } } });

			expect(stderrOutput()).toContain('wikis.w.token');
			expect(stderrOutput()).toContain('plaintext credential');
			expect(stderrOutput()).not.toContain('plain-secret-SENTINEL');
		});

		it('does not warn for resolved ${VAR} secrets', () => {
			parse(
				{ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: '${SAFE_TOKEN}' } } },
				{ SAFE_TOKEN: 'resolved' },
			);

			expect(stderrOutput()).not.toContain('plaintext credential');
		});

		it('does not warn for null secrets', () => {
			parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: null, username: null, password: null } },
			});

			expect(stderrOutput()).not.toContain('plaintext credential');
		});

		it('does not warn for empty-string secrets', () => {
			parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: '' } } });

			expect(stderrOutput()).not.toContain('plaintext credential');
		});

		it('warns once per offending field across multiple wikis', () => {
			parse({
				defaultWiki: 'a',
				wikis: {
					a: { ...baseWiki, token: 'xxxxxxx', password: 'yyyyyyy' },
					b: { ...baseWiki, username: 'zzzzzzz' },
				},
			});

			expect(stderrOutput()).toContain('wikis.a.token');
			expect(stderrOutput()).toContain('wikis.a.password');
			expect(stderrOutput()).toContain('wikis.b.username');
		});
	});

	describe('uploadDirs', () => {
		it('defaults to an empty array when neither source is set', () => {
			expect(parse({ defaultWiki: 'w', wikis: { w: baseWiki } }).uploadDirs).toEqual([]);
		});

		it('parses config.json uploadDirs and canonicalises each entry', () => {
			const realpath = (dir: string): string =>
				dir === '/home/user/uploads' ? '/var/lib/uploads' : dir;

			const config = parse(
				{
					defaultWiki: 'w',
					wikis: { w: baseWiki },
					uploadDirs: ['/home/user/uploads', '/tmp/incoming'],
				},
				{},
				realpath,
			);

			expect(config.uploadDirs).toEqual(['/var/lib/uploads', '/tmp/incoming']);
		});

		it('parses MCP_UPLOAD_DIRS env var with colon separator', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: baseWiki } },
				{ MCP_UPLOAD_DIRS: '/a:/b' },
			);

			expect(config.uploadDirs).toEqual(['/a', '/b']);
		});

		it('unions config.json and env-var sources, dedup after canonicalisation', () => {
			const config = parse(
				{ defaultWiki: 'w', wikis: { w: baseWiki }, uploadDirs: ['/b', '/c'] },
				{ MCP_UPLOAD_DIRS: '/a:/b' },
			);

			expect(config.uploadDirs).toEqual(['/a', '/b', '/c']);
		});

		it('treats empty MCP_UPLOAD_DIRS as unset', () => {
			const config = parse({ defaultWiki: 'w', wikis: { w: baseWiki } }, { MCP_UPLOAD_DIRS: '' });

			expect(config.uploadDirs).toEqual([]);
		});

		it('throws when uploadDirs contains a non-string', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: baseWiki }, uploadDirs: ['/a', 42] }),
			).toThrow(/uploadDirs/);
		});

		it('throws when a config uploadDirs entry is relative', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: baseWiki }, uploadDirs: ['relative/path'] }),
			).toThrow(/must be absolute/);
		});

		it('throws when MCP_UPLOAD_DIRS contains a relative entry', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: baseWiki } }, { MCP_UPLOAD_DIRS: '/ok:relative' }),
			).toThrow(/must be absolute/);
		});

		it('throws when an entry cannot be canonicalised', () => {
			const realpath = (dir: string): string => {
				throw Object.assign(new Error(`ENOENT: ${dir}`), { code: 'ENOENT' });
			};

			expect(() =>
				parse(
					{ defaultWiki: 'w', wikis: { w: baseWiki }, uploadDirs: ['/does/not/exist'] },
					{},
					realpath,
				),
			).toThrow(/cannot be resolved/);
		});
	});

	// A loader that ran the command would hand back its output in place of the
	// {exec} marker.
	describe('exec credential source', () => {
		it('returns an ExecSecret marker without running the command', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: {
					w: {
						...baseWiki,
						token: { exec: { command: 'op', args: ['read', 'op://vault/token'] } },
					},
				},
			});

			expect(config.wikis.w.token).toEqual({
				exec: { command: 'op', args: ['read', 'op://vault/token'] },
			});
		});

		it('normalises a missing args array to []', () => {
			const config = parse({
				defaultWiki: 'w',
				wikis: { w: { ...baseWiki, token: { exec: { command: 'my-helper' } } } },
			});

			expect(config.wikis.w.token).toEqual({ exec: { command: 'my-helper', args: [] } });
		});

		it('runs no exec command at load even across multiple exec-backed wikis', () => {
			const config = parse({
				defaultWiki: 'a',
				wikis: {
					a: { ...baseWiki, token: { exec: { command: 'op', args: ['a'] } } },
					b: { ...baseWiki, username: { exec: { command: 'op', args: ['b'] } } },
				},
			});

			expect(config.wikis.a.token).toEqual({ exec: { command: 'op', args: ['a'] } });
			expect(config.wikis.b.username).toEqual({ exec: { command: 'op', args: ['b'] } });
		});

		it('throws when exec.command is missing or empty', () => {
			expect(() =>
				parse({
					defaultWiki: 'w',
					wikis: { w: { ...baseWiki, token: { exec: { command: '' } } } },
				}),
			).toThrow('Config error: wikis.w.token.exec.command must be a non-empty string');
		});

		it('throws when exec.args is not a string array', () => {
			expect(() =>
				parse({
					defaultWiki: 'w',
					wikis: { w: { ...baseWiki, token: { exec: { command: 'op', args: [1, 2] } } } },
				}),
			).toThrow('Config error: wikis.w.token.exec.args must be an array of strings');
		});

		it('throws for a malformed object in a secret field', () => {
			expect(() =>
				parse({ defaultWiki: 'w', wikis: { w: { ...baseWiki, token: { wrong: 'shape' } } } }),
			).toThrow('Config error: wikis.w.token must be a string, null, or an {exec: …} object');
		});
	});

	describe('oauth2ClientId field', () => {
		it('round-trips a populated value', () => {
			const config = parse({
				defaultWiki: 'a',
				wikis: { a: { ...baseWiki, oauth2ClientId: 'abc123' } },
			});

			expect(config.wikis.a.oauth2ClientId).toBe('abc123');
		});

		it('is undefined when omitted', () => {
			const config = parse({ defaultWiki: 'a', wikis: { a: { ...baseWiki } } });

			expect(config.wikis.a.oauth2ClientId).toBeUndefined();
		});

		it('preserves null verbatim', () => {
			const config = parse({
				defaultWiki: 'a',
				wikis: { a: { ...baseWiki, oauth2ClientId: null } },
			});

			expect(config.wikis.a.oauth2ClientId).toBeNull();
		});
	});
});
