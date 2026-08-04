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
	// Wikibase: the requested entity ID does not exist on the wiki.
	'no-such-entity': 'not_found',
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
	// Wikibase: the ID is not in the wiki's entity-ID format.
	'invalid-entity-id': 'invalid_input',
	// Wikibase writes: a parameter is missing, malformed, or names something the
	// entity does not hold. `modification-failed` covers a change the entity
	// itself refuses, such as a duplicate term or a statement that already exists.
	'param-illegal': 'invalid_input',
	'param-missing': 'invalid_input',
	'invalid-snak': 'invalid_input',
	'no-such-claim': 'invalid_input',
	'not-recognized': 'invalid_input',
	'modification-failed': 'invalid_input',
	// Wikibase writes: the request describes a change the entity cannot apply.
	// The data is absent, a value is malformed, or a payload field contradicts
	// the parameter sent alongside it.
	'inconsistent-language': 'invalid_input',
	'inconsistent-site': 'invalid_input',
	'no-data': 'invalid_input',
	'param-invalid': 'invalid_input',
	'invalid-guid': 'invalid_input',
	'tags-invalid': 'invalid_input',
	'failed-modify': 'invalid_input',
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
	// rate_limited
	ratelimited: 'rate_limited',
	// upstream_failure (explicit; unknown codes also fall through here)
	readonly: 'upstream_failure',
};

// Code families the wiki numbers per case, matched by prefix rather than by
// exact value. Wikibase reports a caller-supplied JSON value it cannot read as
// `not-recognized-<shape>`, one code per shape it expected.
const CODE_PREFIX_PATTERNS: readonly (readonly [RegExp, ErrorCategory])[] = [
	[/^internal_api_error_/, 'upstream_failure'],
	[/^not-recognized-/, 'invalid_input'],
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

export function classifyError(err: unknown): { category: ErrorCategory; code?: string } {
	if (err instanceof CredentialResolutionError) {
		return { category: 'authentication' };
	}
	if (err !== null && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		if (typeof code === 'string') {
			const mapped = MW_CODE_TO_CATEGORY[code];
			if (mapped) {
				return { category: mapped, code };
			}
			for (const [pattern, category] of CODE_PREFIX_PATTERNS) {
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
	public classify(err: unknown): { category: ErrorCategory; code?: string } {
		return classifyError(err);
	}
}
