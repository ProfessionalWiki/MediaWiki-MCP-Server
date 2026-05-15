import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../runtime/logger.js';
import { errorMessage } from '../errors/isErrnoException.js';

export interface WikiConfig {
	/**
	 * Corresponds to the $wgSitename setting in MediaWiki.
	 */
	sitename: string;
	/**
	 * Corresponds to the $wgServer setting in MediaWiki.
	 */
	server: string;
	/**
	 * Corresponds to the $wgArticlePath setting in MediaWiki.
	 */
	articlepath: string;
	/**
	 * Corresponds to the $wgScriptPath setting in MediaWiki.
	 */
	scriptpath: string;
	/**
	 * OAuth consumer token requested from Extension:OAuth.
	 * Used as a fallback when no Authorization header is supplied
	 * by the MCP client on the HTTP request.
	 */
	token?: string | ExecSecret | null;
	/**
	 * Username requested from Special:BotPasswords.
	 */
	username?: string | ExecSecret | null;
	/**
	 * Password requested from Special:BotPasswords.
	 */
	password?: string | ExecSecret | null;
	/**
	 * OAuth 2.0 client identifier registered at
	 * Special:OAuthConsumerRegistration/propose/oauth2 on this wiki.
	 * Presence opts the wiki into OAuth: HTTP transport advertises it in
	 * /.well-known/oauth-protected-resource, and stdio runtime triggers
	 * a browser-based login when no live token is stored.
	 * Public client (PKCE only) — no client secret needed.
	 */
	oauth2ClientId?: string | null;
	/**
	 * Fixed loopback port for the OAuth 2.0 callback during the stdio
	 * browser dance. Set this when the wiki's authorization server
	 * exact-matches the registered redirect URI — notably MediaWiki's
	 * Extension:OAuth, which does not honour RFC 8252 §7.3 loopback
	 * port flexibility for OAuth 2.0 consumers. The callback URL
	 * registered on the wiki must then be
	 * `http://127.0.0.1:<port>/oauth/callback`. When unset, the OS
	 * picks an ephemeral port (works only against AS that follow
	 * RFC 8252).
	 */
	oauth2CallbackPort?: number | null;
	/**
	 * If the wiki always requires auth to access.
	 * $wgGroupPermissions['*']['read'] = false; in MediaWiki
	 */
	private?: boolean;
	/**
	 * When true, the six write tools (create-page, update-page,
	 * delete-page, undelete-page, upload-file, upload-file-from-url)
	 * are hidden from tools/list while this wiki is the active wiki.
	 * Defaults to false.
	 */
	readOnly?: boolean;
	/**
	 * Change tag(s) applied to every write action made through this MCP
	 * server. The tag(s) must be registered and active on the wiki (see
	 * Special:Tags on the target wiki). If the tag is not applicable to
	 * the action, MediaWiki returns a badtags error and the write fails.
	 */
	tags?: string | string[] | null;
}

export type PublicWikiConfig = Omit<WikiConfig, 'token' | 'username' | 'password'>;

export interface Config {
	wikis: { [key: string]: WikiConfig };
	defaultWiki: string;
	/**
	 * When false, the `add-wiki` and `remove-wiki` tools are disabled, freezing
	 * the configured wiki set at startup. Defaults to true.
	 */
	allowWikiManagement?: boolean;
	/**
	 * Absolute directories from which `upload-file` may read. Merged from
	 * `config.json` `uploadDirs` and the `MCP_UPLOAD_DIRS` env var. Each entry
	 * is canonicalised via `fs.realpathSync` at load. Empty → uploads disabled.
	 */
	uploadDirs: readonly string[];
}

export const defaultConfig: Config = {
	defaultWiki: 'en.wikipedia.org',
	uploadDirs: [],
	wikis: {
		'en.wikipedia.org': {
			sitename: 'Wikipedia',
			server: 'https://en.wikipedia.org',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: null,
			private: false,
		},
		'localhost:8080': {
			sitename: 'Local MediaWiki Docker',
			server: 'http://localhost:8080',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: null,
			private: false,
		},
	},
};

/**
 * A credential field whose value is produced by running an external command.
 * Validated at config load (see parseExecSecret); the command itself runs
 * lazily on first use of the wiki — see src/wikis/execSecret.ts.
 */
export interface ExecSecret {
	exec: {
		command: string;
		args: string[];
	};
}

/**
 * Whether a credential field is configured — i.e. carries a usable secret
 * source. True for a non-empty string and for an {exec:…} object; false for
 * an empty string, null, or undefined. Used to classify a wiki as having
 * static credentials without resolving (running) an exec-backed secret.
 */
export function isCredentialConfigured(value: string | ExecSecret | null | undefined): boolean {
	if (typeof value === 'string') {
		return value.length > 0;
	}
	return value !== null && value !== undefined;
}

const SECRET_FIELDS = ['token', 'username', 'password'] as const;
type SecretFieldName = (typeof SECRET_FIELDS)[number];

function isSecretField(name: string): name is SecretFieldName {
	return (SECRET_FIELDS as readonly string[]).includes(name);
}

const configPath = process.env.CONFIG || 'config.json';

function replaceEnvVars(value: string): string {
	return value.replace(/\$\{([^}]+)\}/g, (match, envVar: string) => {
		const envValue = process.env[envVar];
		return envValue !== undefined ? envValue : match;
	});
}

function replaceEnvVarsInObject(obj: unknown): unknown {
	if (typeof obj === 'string') {
		return replaceEnvVars(obj);
	}
	if (Array.isArray(obj)) {
		return obj.map((item) => replaceEnvVarsInObject(item));
	}
	if (obj !== null && typeof obj === 'object') {
		const result: Record<string, unknown> = {};
		for (const [key, value] of Object.entries(obj)) {
			result[key] = replaceEnvVarsInObject(value);
		}
		return result;
	}
	return obj;
}

function resolveSecretField(
	raw: unknown,
	wikiKey: string,
	fieldName: SecretFieldName,
): string | ExecSecret | null | undefined {
	if (raw === null || raw === undefined) {
		return raw;
	}
	if (typeof raw === 'string') {
		if (raw.includes('${')) {
			const substituted = replaceEnvVars(raw);
			const unresolved = substituted.match(/\$\{([^}]+)\}/);
			if (unresolved) {
				throw new Error(
					`Config error: environment variable "${unresolved[1]}" referenced by wikis.${wikiKey}.${fieldName} is not set`,
				);
			}
			return substituted;
		}
		if (raw !== '') {
			logger.warning(
				`wikis.${wikiKey}.${fieldName} contains a plaintext credential. Prefer \${VAR} or an {exec: …} object. See README.`,
			);
		}
		return raw;
	}
	if (typeof raw === 'object' && !Array.isArray(raw)) {
		return parseExecSecret(raw, `wikis.${wikiKey}.${fieldName}`);
	}
	throw new Error(
		`Config error: wikis.${wikiKey}.${fieldName} must be a string, null, or an {exec: …} object`,
	);
}

function parseExecSecret(raw: unknown, fieldPath: string): ExecSecret {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`Config error: ${fieldPath} must be a string, null, or an {exec: …} object`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	const src = raw as { exec?: unknown };
	if (typeof src.exec !== 'object' || src.exec === null || Array.isArray(src.exec)) {
		throw new Error(`Config error: ${fieldPath} must be a string, null, or an {exec: …} object`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	const exec = src.exec as { command?: unknown; args?: unknown };
	if (typeof exec.command !== 'string' || exec.command === '') {
		throw new Error(`Config error: ${fieldPath}.exec.command must be a non-empty string`);
	}
	if (
		exec.args !== undefined &&
		(!Array.isArray(exec.args) || !exec.args.every((a) => typeof a === 'string'))
	) {
		throw new Error(`Config error: ${fieldPath}.exec.args must be an array of strings`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	return { exec: { command: exec.command, args: (exec.args as string[]) ?? [] } };
}

function resolveUploadDirs(rawFromConfig: unknown): readonly string[] {
	const fromConfig: string[] = [];
	if (rawFromConfig !== undefined) {
		if (!Array.isArray(rawFromConfig)) {
			throw new Error('Config error: uploadDirs must be an array of strings');
		}
		for (const entry of rawFromConfig) {
			if (typeof entry !== 'string') {
				throw new Error('Config error: uploadDirs entries must be strings');
			}
			if (!path.isAbsolute(entry)) {
				throw new Error(`Config error: uploadDirs entry "${entry}" must be absolute`);
			}
			fromConfig.push(entry);
		}
	}

	const envRaw = process.env.MCP_UPLOAD_DIRS;
	const fromEnv: string[] = [];
	if (envRaw) {
		for (const entry of envRaw.split(':')) {
			if (entry === '') {
				continue;
			}
			if (!path.isAbsolute(entry)) {
				throw new Error(`Config error: MCP_UPLOAD_DIRS entry "${entry}" must be absolute`);
			}
			fromEnv.push(entry);
		}
	}

	const canonicalised: string[] = [];
	for (const raw of [...fromEnv, ...fromConfig]) {
		let canonical: string;
		try {
			canonical = fs.realpathSync(raw);
		} catch (err) {
			throw new Error(
				`Config error: upload directory "${raw}" cannot be resolved (${errorMessage(err)}). Ensure the directory exists before starting the server.`,
			);
		}
		if (!canonicalised.includes(canonical)) {
			canonicalised.push(canonical);
		}
	}
	return canonicalised;
}

function resolveWiki(raw: unknown, wikiKey: string): WikiConfig {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`Config error: wikis.${wikiKey} must be an object`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	const src = raw as Record<string, unknown>;
	const resolved: Record<string, unknown> = {};
	for (const [fieldKey, fieldValue] of Object.entries(src)) {
		if (isSecretField(fieldKey)) {
			resolved[fieldKey] = resolveSecretField(fieldValue, wikiKey, fieldKey);
		} else {
			resolved[fieldKey] = replaceEnvVarsInObject(fieldValue);
		}
	}
	if (resolved.readOnly !== undefined && typeof resolved.readOnly !== 'boolean') {
		throw new Error(`Config error: wikis.${wikiKey}.readOnly must be a boolean`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	return resolved as unknown as WikiConfig;
}

function resolveConfig(parsed: unknown): Config {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Config error: config.json must be an object');
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; ajv-validated WikiConfig parsing is a separate follow-up
	const p = parsed as Record<string, unknown>;
	const defaultWiki = typeof p.defaultWiki === 'string' ? replaceEnvVars(p.defaultWiki) : '';
	const allowWikiManagement =
		typeof p.allowWikiManagement === 'boolean' ? p.allowWikiManagement : undefined;
	const uploadDirs = resolveUploadDirs(p.uploadDirs);
	const rawWikis = p.wikis;
	if (typeof rawWikis !== 'object' || rawWikis === null || Array.isArray(rawWikis)) {
		return { defaultWiki, wikis: {}, allowWikiManagement, uploadDirs };
	}
	const wikis: Record<string, WikiConfig> = {};
	for (const [key, rawWiki] of Object.entries(rawWikis)) {
		wikis[key] = resolveWiki(rawWiki, key);
	}
	return { defaultWiki, wikis, allowWikiManagement, uploadDirs };
}

export function loadConfigFromFile(): Config {
	if (!fs.existsSync(configPath)) {
		return { ...defaultConfig, uploadDirs: resolveUploadDirs(undefined) };
	}
	const rawData = fs.readFileSync(configPath, 'utf-8');
	const parsed = JSON.parse(rawData);
	return resolveConfig(parsed);
}
