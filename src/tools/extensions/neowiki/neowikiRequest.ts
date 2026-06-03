import type { Mwn } from 'mwn';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ErrorCategory } from '../../../errors/classifyError.js';
import type { ToolContext } from '../../../runtime/context.js';

/** A NeoWiki REST failure already classified into an MCP error category. */
export class NeoWikiApiError extends Error {
	public constructor(
		public readonly category: ErrorCategory,
		message: string,
	) {
		super(message);
		this.name = 'NeoWikiApiError';
	}
}

export interface NeoWikiRequestSpec {
	readonly method: 'GET' | 'POST';
	/** Path under `/neowiki/v0`, already URL-encoded, e.g. `/schema/Person`. */
	readonly path: string;
	readonly query?: Record<string, string>;
	readonly body?: unknown;
}

// NeoWiki's `errorType` strings are stable across releases (per query-api docs);
// branch on them, never on the translated `message`.
const ERROR_TYPE_TO_CATEGORY: Record<string, ErrorCategory> = {
	emptyQuery: 'invalid_input',
	parameterMissing: 'invalid_input',
	cypherSyntaxError: 'invalid_input',
	writeQueryRejected: 'invalid_input',
	queryTimeout: 'upstream_failure',
	rateLimitExceeded: 'rate_limited',
	permissionDenied: 'permission_denied',
	backendUnavailable: 'upstream_failure',
	internalError: 'upstream_failure',
};

function restBaseFrom(apiUrl: string): string {
	// apiUrl is `${server}${scriptpath}/api.php`; NeoWiki REST lives at
	// `${server}${scriptpath}/rest.php/neowiki/v0` — same origin, so the bearer
	// and cookies that reach the action API also reach here.
	return `${apiUrl.replace(/\/api\.php$/, '/rest.php')}/neowiki/v0`;
}

export async function neowikiRequest(mwn: Mwn, spec: NeoWikiRequestSpec): Promise<unknown> {
	const apiUrl = mwn.options.apiUrl;
	if (typeof apiUrl !== 'string' || !/\/api\.php$/.test(apiUrl)) {
		throw new NeoWikiApiError(
			'upstream_failure',
			'Cannot derive the NeoWiki REST base from the wiki API URL.',
		);
	}

	let url = `${restBaseFrom(apiUrl)}${spec.path}`;
	if (spec.query !== undefined && Object.keys(spec.query).length > 0) {
		url += `?${new URLSearchParams(spec.query).toString()}`;
	}

	const headers: Record<string, string> = { Accept: 'application/json' };
	if (spec.body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}
	// rawRequest skips mwn.applyAuthentication, so inject the OAuth2 bearer
	// ourselves (same-origin by construction). Bot-password cookies still flow
	// via mwn's axios interceptor.
	if (mwn.usingOAuth2 && typeof mwn.options.OAuth2AccessToken === 'string') {
		headers.Authorization = `Bearer ${mwn.options.OAuth2AccessToken}`;
	}

	try {
		const response = await mwn.rawRequest({
			url,
			method: spec.method,
			headers,
			...(spec.body !== undefined ? { data: JSON.stringify(spec.body) } : {}),
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios response body at this boundary
		return (response as { data: unknown }).data;
	} catch (err: unknown) {
		throw classifyNeoWikiError(err);
	}
}

function classifyNeoWikiError(err: unknown): NeoWikiApiError {
	// axios throws on non-2xx with `err.response.{status,data}`.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios error shape at this boundary
	const response = (err as { response?: { status?: number; data?: unknown } }).response;
	const status = response?.status;
	const data = response?.data;

	if (data !== null && typeof data === 'object') {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- verified non-null object above; narrow to inspect keys
		const record = data as Record<string, unknown>;

		const errorType = record.errorType;
		if (typeof errorType === 'string') {
			const category = ERROR_TYPE_TO_CATEGORY[errorType] ?? 'upstream_failure';
			const message = typeof record.message === 'string' ? record.message : errorType;
			return new NeoWikiApiError(category, message);
		}

		// REST param-validation envelope: { error, messageTranslations: { en } }.
		if (typeof record.error === 'string') {
			const translations = record.messageTranslations;
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- messageTranslations sub-object shape at this boundary
			const en =
				translations !== null && typeof translations === 'object'
					? (translations as { en?: unknown }).en
					: undefined;
			const message = typeof en === 'string' ? en : record.error;
			return new NeoWikiApiError(status === 404 ? 'not_found' : 'invalid_input', message);
		}

		// Internal RuntimeException: { message, exception: {…backtrace…} }.
		// Surface the message only — never the backtrace.
		if (typeof record.message === 'string') {
			return new NeoWikiApiError('upstream_failure', record.message);
		}
	}

	if (status === 404) {
		return new NeoWikiApiError('not_found', 'NeoWiki resource not found.');
	}
	if (status === 403) {
		return new NeoWikiApiError('permission_denied', 'Permission denied by NeoWiki.');
	}
	if (status === 429) {
		return new NeoWikiApiError('rate_limited', 'NeoWiki rate limit exceeded.');
	}

	// Covers both axios network errors (no .response — timeout, ECONNREFUSED) and unrecognised body shapes.
	const message = err instanceof Error ? err.message : String(err);
	return new NeoWikiApiError('upstream_failure', message);
}

/**
 * Converts a thrown `NeoWikiApiError` into an MCP error result; re-throws any
 * other error so the dispatcher classifies it (→ `upstream_failure`). Call from
 * a tool handler's catch block.
 */
export function neowikiErrorResult(err: unknown, ctx: ToolContext): CallToolResult {
	if (err instanceof NeoWikiApiError) {
		return ctx.format.error(err.category, err.message);
	}
	throw err;
}
