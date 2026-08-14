import { CredentialResolutionError } from './credentialResolutionError.ts';

export type ErrorCategory =
	| 'not_found'
	| 'permission_denied'
	| 'invalid_input'
	| 'conflict'
	| 'upstream_failure'
	| 'rate_limited'
	| 'authentication';

export interface ErrorClassifier {
	classify(err: unknown): { category: ErrorCategory; code?: string };
}

const MW_CODE_TO_CATEGORY: Record<string, ErrorCategory> = {
	// not_found
	missingtitle: 'not_found',
	nosuchrevid: 'not_found',
	nosuchsection: 'not_found',
	nofile: 'not_found',
	// permission_denied
	permissiondenied: 'permission_denied',
	protectedpage: 'permission_denied',
	protectedtitle: 'permission_denied',
	cascadeprotected: 'permission_denied',
	cantcreate: 'permission_denied',
	cantmove: 'permission_denied',
	'cantmove-anon': 'permission_denied',
	readapidenied: 'permission_denied',
	writeapidenied: 'permission_denied',
	blocked: 'permission_denied',
	'abusefilter-disallowed': 'permission_denied',
	'abusefilter-warning': 'permission_denied',
	// Editing a namespace listed in $wgNamespaceProtection without the required
	// right. Core emits namespaceprotected (or protectedinterface for MediaWiki:);
	// older versions use the protectednamespace spellings. Match all four.
	protectednamespace: 'permission_denied',
	'protectednamespace-interface': 'permission_denied',
	namespaceprotected: 'permission_denied',
	protectedinterface: 'permission_denied',
	// invalid_input
	invalidtitle: 'invalid_input',
	invalidparammix: 'invalid_input',
	badvalue: 'invalid_input',
	baddatatype: 'invalid_input',
	paramempty: 'invalid_input',
	badtags: 'invalid_input',
	selfmove: 'invalid_input',
	immobilenamespace: 'invalid_input',
	nonfilenamespace: 'invalid_input',
	filetypemismatch: 'invalid_input',
	// conflict
	editconflict: 'conflict',
	articleexists: 'conflict',
	fileexists: 'conflict',
	'fileexists-no-change': 'conflict',
	// authentication
	notloggedin: 'authentication',
	badtoken: 'authentication',
	mustbeloggedin: 'authentication',
	assertuserfailed: 'authentication',
	assertbotfailed: 'authentication',
	// An expired or otherwise invalid OAuth access token: MediaWiki's OAuth
	// extension rejects the request with this code. Classifying it as
	// authentication (not upstream_failure) lets OAuth-aware callers tell a dead
	// token apart from a genuine upstream fault and start a token refresh.
	'mwoauth-invalid-authorization': 'authentication',
	// A bot-password login the wiki rejected, or one attempted with an incomplete
	// pair. These are mwn's own codes rather than the action API's: the failure
	// happens while establishing the session, before any tool's request is sent.
	// The credentials are the caller's own when they arrived as `Authorization:
	// Basic`, so the category has to say "fix your credentials" rather than blame
	// the wiki.
	mwn_failedlogin: 'authentication',
	mwn_nologincredentials: 'authentication',
	// rate_limited
	ratelimited: 'rate_limited',
	// upstream_failure (explicit; unknown codes also fall through here)
	readonly: 'upstream_failure',
};

// Code families the wiki numbers per case, matched by prefix rather than by
// exact value.
const CODE_PREFIX_PATTERNS: readonly (readonly [RegExp, ErrorCategory])[] = [
	[/^internal_api_error_/, 'upstream_failure'],
];

// mwn sometimes surfaces codes only inside the error message, not on .code.
// These patterns infer a canonical code from the message, which then routes
// through MW_CODE_TO_CATEGORY.
const MESSAGE_FALLBACK_PATTERNS: readonly (readonly [RegExp, string])[] = [
	[/\bmissingtitle\b/i, 'missingtitle'],
	[/\bnosuchrevid\b/i, 'nosuchrevid'],
	[/\bnosuchsection\b/i, 'nosuchsection'],
	[/\beditconflict\b/i, 'editconflict'],
	[/\bratelimited\b/i, 'ratelimited'],
];

/**
 * Error codes an extension adds to the action API's vocabulary, supplied by the
 * packs rather than listed here, so a pack owns the codes only it can produce.
 */
export interface ExtensionErrorVocabulary {
	codes: Readonly<Record<string, ErrorCategory>>;
	prefixes: readonly (readonly [RegExp, ErrorCategory])[];
}

const NO_EXTENSION_CODES: ExtensionErrorVocabulary = { codes: {}, prefixes: [] };

export function classifyError(
	err: unknown,
	extensions: ExtensionErrorVocabulary = NO_EXTENSION_CODES,
): { category: ErrorCategory; code?: string } {
	if (err instanceof CredentialResolutionError) {
		return { category: 'authentication' };
	}
	if (err !== null && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		if (typeof code === 'string') {
			// Core first: a pack cannot reinterpret a code the wiki already defines,
			// and registration rejects an overlap before it could try.
			const mapped = MW_CODE_TO_CATEGORY[code] ?? extensions.codes[code];
			if (mapped) {
				return { category: mapped, code };
			}
			for (const [pattern, category] of [...CODE_PREFIX_PATTERNS, ...extensions.prefixes]) {
				if (pattern.test(code)) {
					return { category, code };
				}
			}
		}
		const message = (err as { message?: unknown }).message;
		if (typeof code !== 'string' && typeof message === 'string') {
			for (const [pattern, inferredCode] of MESSAGE_FALLBACK_PATTERNS) {
				if (pattern.test(message)) {
					return {
						category: MW_CODE_TO_CATEGORY[inferredCode],
						code: inferredCode,
					};
				}
			}
		}
	}
	return { category: 'upstream_failure' };
}

export class ErrorClassifierImpl implements ErrorClassifier {
	public constructor(private readonly extensions: ExtensionErrorVocabulary = NO_EXTENSION_CODES) {}

	public classify(err: unknown): { category: ErrorCategory; code?: string } {
		return classifyError(err, this.extensions);
	}
}

/** The core vocabulary, for the registration check that keeps packs out of it. */
export function coreErrorCodes(): Readonly<Record<string, ErrorCategory>> {
	return MW_CODE_TO_CATEGORY;
}
