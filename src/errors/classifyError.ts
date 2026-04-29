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
	readapidenied: 'permission_denied',
	writeapidenied: 'permission_denied',
	blocked: 'permission_denied',
	'abusefilter-disallowed': 'permission_denied',
	'abusefilter-warning': 'permission_denied',
	// invalid_input
	invalidtitle: 'invalid_input',
	invalidparammix: 'invalid_input',
	badvalue: 'invalid_input',
	baddatatype: 'invalid_input',
	paramempty: 'invalid_input',
	badtags: 'invalid_input',
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
	// rate_limited
	ratelimited: 'rate_limited',
	// upstream_failure (explicit; unknown codes also fall through here)
	readonly: 'upstream_failure',
};

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
	if (err !== null && typeof err === 'object') {
		const code = (err as { code?: unknown }).code;
		if (typeof code === 'string') {
			const mapped = MW_CODE_TO_CATEGORY[code];
			if (mapped) {
				return { category: mapped, code };
			}
			if (/^internal_api_error_/.test(code)) {
				return { category: 'upstream_failure', code };
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
