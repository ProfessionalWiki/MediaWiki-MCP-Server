import * as fs from 'fs';
import * as path from 'path';
import { logger } from '../runtime/logger.ts';
import { errorMessage } from '../errors/isErrnoException.ts';
import { wikiKeyProblem, wikiKeyProblemMessage } from '../runtime/wikiKey.ts';

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
	 * A public (PKCE) consumer needs no secret; set `oauth2ClientSecret` to use a
	 * confidential consumer (required for the proxy's upstream token refresh).
	 */
	oauth2ClientId?: string | null;
	/**
	 * OAuth 2.0 client secret for a CONFIDENTIAL upstream consumer. Optional: omit
	 * for a public (PKCE) consumer. MediaWiki requires client authentication on the
	 * refresh grant, so without a confidential consumer + this secret the hosted
	 * proxy cannot refresh the upstream token and a session ends when the upstream
	 * access token expires. Being a secret, prefer `${MCP_OAUTH2_CLIENT_SECRET}`
	 * substitution or the `MCP_OAUTH2_CLIENT_SECRET` env override over config.json.
	 */
	oauth2ClientSecret?: string | null;
	/**
	 * Public base URL of the wiki (e.g. https://wiki.example) used ONLY to build the
	 * browser-facing upstream OAuth authorize URL when the hosted proxy is enabled.
	 * Defaults to `server` when unset. Needed when `server` is an internal alias the
	 * user's browser cannot reach (e.g. http://mediawiki.svc).
	 */
	publicServer?: string | null;
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
	 * When true, write tools — the core page/file writes plus extension-pack
	 * writes (identified by readOnlyHint: false) — are rejected for this wiki
	 * by the per-call guard, and hidden from tools/list when no configured
	 * wiki is writable. Defaults to false.
	 */
	readOnly?: boolean;
	/**
	 * Change tag(s) applied to every write action made through this MCP
	 * server. The tag(s) must be registered and active on the wiki (see
	 * Special:Tags on the target wiki). If the tag is not applicable to
	 * the action, MediaWiki returns a badtags error and the write fails.
	 */
	tags?: string | string[] | null;
	/**
	 * Whether write actions made through this MCP server carry the
	 * `(via <tool> on MediaWiki MCP Server)` attribution suffix in their edit
	 * summary. Defaults to true. Set to false to drop the suffix, leaving only
	 * the caller-supplied comment — or an empty summary when none was given.
	 * A change tag (`tags`) keeps MCP edits identifiable without the suffix when
	 * you control the target wiki.
	 */
	attributeEdits?: boolean;
}

/**
 * The wiki fields safe to publish over MCP. Deliberately a `Pick`, not an
 * `Omit` of the known secrets: subtracting secrets means every field added to
 * `WikiConfig` later is published by default, which is how `oauth2ClientSecret`
 * came to be served to clients. Adding a field here must be a decision.
 */
export type PublicWikiConfig = Pick<
	WikiConfig,
	'sitename' | 'server' | 'articlepath' | 'scriptpath' | 'private' | 'readOnly'
>;

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
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary
	const src = raw as { exec?: unknown };
	if (typeof src.exec !== 'object' || src.exec === null || Array.isArray(src.exec)) {
		throw new Error(`Config error: ${fieldPath} must be a string, null, or an {exec: …} object`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary
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
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary
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

type FieldKind = 'string' | 'boolean' | 'number' | 'stringOrStringArray';

interface FieldType {
	kind: FieldKind;
	/** True for the fields whose declared type includes `null`. */
	nullable?: boolean;
}

const KIND_DESCRIPTIONS: Record<FieldKind, string> = {
	string: 'a string',
	boolean: 'a boolean',
	number: 'a number',
	stringOrStringArray: 'a string or an array of strings',
};

const KIND_PREDICATES: Record<FieldKind, (value: unknown) => boolean> = {
	string: (value) => typeof value === 'string',
	boolean: (value) => typeof value === 'boolean',
	number: (value) => typeof value === 'number',
	stringOrStringArray: (value) =>
		typeof value === 'string' ||
		(Array.isArray(value) && value.every((entry) => typeof entry === 'string')),
};

/**
 * The declared type of each config field. Keyed off `Config` and `WikiConfig`
 * so that a field added to either without an entry here is a compile error
 * rather than a field that quietly stops being validated. The credential
 * fields are excluded because `resolveSecretField` parses them, and
 * `uploadDirs` and `wikis` because `resolveUploadDirs` and `resolveWiki` do.
 */
const CONFIG_FIELD_TYPES: Record<Exclude<keyof Config, 'wikis' | 'uploadDirs'>, FieldType> = {
	defaultWiki: { kind: 'string' },
	allowWikiManagement: { kind: 'boolean' },
};

const WIKI_FIELD_TYPES: Record<Exclude<keyof WikiConfig, SecretFieldName>, FieldType> = {
	sitename: { kind: 'string' },
	server: { kind: 'string' },
	articlepath: { kind: 'string' },
	scriptpath: { kind: 'string' },
	publicServer: { kind: 'string', nullable: true },
	oauth2ClientId: { kind: 'string', nullable: true },
	oauth2ClientSecret: { kind: 'string', nullable: true },
	oauth2CallbackPort: { kind: 'number', nullable: true },
	private: { kind: 'boolean' },
	readOnly: { kind: 'boolean' },
	attributeEdits: { kind: 'boolean' },
	tags: { kind: 'stringOrStringArray', nullable: true },
};

/**
 * Refuses a field whose value does not have its declared type. TypeScript
 * erases the declarations, so without this a `"true"` written for a boolean
 * reaches the strict comparisons that read it, matches neither `true` nor
 * `false`, and leaves the field at its default — which for `readOnly` and
 * `private` leaves a deployment the operator meant to lock down open. Coercing
 * instead of refusing would answer `"false"` with `true`, so refusing is the
 * only reading that cannot be wrong.
 *
 * `pathPrefix` names the object being checked and ends in a dot, or is empty
 * for the top level.
 */
function assertFieldTypes(
	source: Record<string, unknown>,
	types: Record<string, FieldType>,
	pathPrefix: string,
): void {
	for (const [field, type] of Object.entries(types)) {
		const value = source[field];
		if (value === undefined || (value === null && type.nullable === true)) {
			continue;
		}
		if (KIND_PREDICATES[type.kind](value)) {
			continue;
		}
		const quoting =
			typeof value === 'string' && (type.kind === 'boolean' || type.kind === 'number')
				? ' Remove the quotes.'
				: '';
		// An array reaching a field that accepts one is an array of the wrong
		// contents, which "an array" would not tell the reader.
		const actual =
			type.kind === 'stringOrStringArray' && Array.isArray(value)
				? 'an array with a non-string entry'
				: describeValue(value);
		throw new Error(
			`Config error: ${pathPrefix}${field} must be ${KIND_DESCRIPTIONS[type.kind]}, but is ${actual}.${quoting}`,
		);
	}
}

function describeValue(value: unknown): string {
	if (value === null) {
		return 'null';
	}
	if (Array.isArray(value)) {
		return 'an array';
	}
	switch (typeof value) {
		case 'string':
			return 'a string';
		case 'number':
			return 'a number';
		case 'boolean':
			return 'a boolean';
		default:
			return 'an object';
	}
}

function resolveWiki(raw: unknown, wikiKey: string): WikiConfig {
	if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
		throw new Error(`Config error: wikis.${wikiKey} must be an object`);
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary
	const src = raw as Record<string, unknown>;
	const resolved: Record<string, unknown> = {};
	for (const [fieldKey, fieldValue] of Object.entries(src)) {
		if (isSecretField(fieldKey)) {
			resolved[fieldKey] = resolveSecretField(fieldValue, wikiKey, fieldKey);
		} else {
			resolved[fieldKey] = replaceEnvVarsInObject(fieldValue);
		}
	}
	assertFieldTypes(resolved, WIKI_FIELD_TYPES, `wikis.${wikiKey}.`);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; the type of each field present is checked above, its presence is not
	return resolved as unknown as WikiConfig;
}

function resolveConfig(parsed: unknown): Config {
	if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
		throw new Error('Config error: config.json must be an object');
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary
	const p = parsed as Record<string, unknown>;
	assertFieldTypes(p, CONFIG_FIELD_TYPES, '');
	const defaultWiki = typeof p.defaultWiki === 'string' ? replaceEnvVars(p.defaultWiki) : '';
	const allowWikiManagement =
		typeof p.allowWikiManagement === 'boolean' ? p.allowWikiManagement : undefined;
	const uploadDirs = resolveUploadDirs(p.uploadDirs);
	const rawWikis = p.wikis;
	if (rawWikis === undefined) {
		return { defaultWiki, wikis: {}, allowWikiManagement, uploadDirs };
	}
	if (typeof rawWikis !== 'object' || rawWikis === null || Array.isArray(rawWikis)) {
		throw new Error(`Config error: wikis must be an object, but is ${describeValue(rawWikis)}.`);
	}
	const wikis: Record<string, WikiConfig> = {};
	for (const [key, rawWiki] of Object.entries(rawWikis)) {
		const problem = wikiKeyProblem(key);
		if (problem !== undefined) {
			throw new Error(`Config error: wiki key "${key}" ${wikiKeyProblemMessage(problem)}`);
		}
		wikis[key] = resolveWiki(rawWiki, key);
	}
	applyOAuth2ClientIdOverride(wikis, defaultWiki);
	applyOAuth2ClientSecretOverride(wikis, defaultWiki);
	return { defaultWiki, wikis, allowWikiManagement, uploadDirs };
}

/**
 * `MCP_OAUTH2_CLIENT_ID` overrides the DEFAULT wiki's `oauth2ClientId`. The id is
 * generated by the wiki when its OAuth2 consumer is registered, so it isn't known
 * until deploy time; this lets a deployment supply it via the environment —
 * alongside `MCP_PUBLIC_URL` / `MCP_OAUTH_JWT_SIGNING_KEY` — instead of baking it
 * into config.json. The env value wins over the file; a blank value is ignored so
 * it can't blank out a configured id.
 */
function applyOAuth2ClientIdOverride(wikis: Record<string, WikiConfig>, defaultWiki: string): void {
	const fromEnv = process.env.MCP_OAUTH2_CLIENT_ID?.trim();
	if (fromEnv && wikis[defaultWiki]) {
		wikis[defaultWiki].oauth2ClientId = fromEnv;
	}
}

/**
 * `MCP_OAUTH2_CLIENT_SECRET` overrides the DEFAULT wiki's `oauth2ClientSecret`,
 * mirroring the client-id override. A confidential consumer's secret is deploy-time
 * data best kept out of config.json; the env value wins over the file and a blank
 * value is ignored so it can't blank out a configured secret.
 */
function applyOAuth2ClientSecretOverride(
	wikis: Record<string, WikiConfig>,
	defaultWiki: string,
): void {
	const fromEnv = process.env.MCP_OAUTH2_CLIENT_SECRET?.trim();
	if (fromEnv && wikis[defaultWiki]) {
		wikis[defaultWiki].oauth2ClientSecret = fromEnv;
	}
}

export function loadConfigFromFile(): Config {
	if (!fs.existsSync(configPath)) {
		if (process.env.CONFIG) {
			logger.warning(
				`CONFIG points at "${configPath}", which does not exist. Falling back to the built-in default configuration (English Wikipedia). A relative path resolves against the server's working directory.`,
			);
		}
		return { ...defaultConfig, uploadDirs: resolveUploadDirs(undefined) };
	}
	const rawData = fs.readFileSync(configPath, 'utf-8');
	const parsed = JSON.parse(rawData);
	return resolveConfig(parsed);
}
