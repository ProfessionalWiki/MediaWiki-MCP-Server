import type { Mwn } from 'mwn';
import { ClassifiedError, type ErrorCategory } from '../../../errors/classifyError.ts';
import { WikiTimeoutError } from '../../../errors/wikiTimeoutError.ts';
import { errorMessage } from '../../../errors/errorMessage.ts';
import { wikiAuthorization } from '../../../wikis/wikiAuthorization.ts';

export interface NeoWikiRequestSpec {
	readonly method: 'GET' | 'POST' | 'PUT' | 'DELETE';
	/** Path under `/neowiki/v0`, already URL-encoded, e.g. `/subject/s1`. */
	readonly path: string;
	readonly query?: Record<string, string>;
	readonly body?: unknown;
	/**
	 * When true, fetch a CSRF token via `mwn.getCsrfToken()` and send it as the
	 * `X-CSRF-TOKEN` header NeoWiki requires on every mutating endpoint. Omit for
	 * reads and the `validate` dry-runs, which take no token.
	 */
	readonly csrf?: boolean;
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

// The write endpoints (create/replace/delete/set-main) use a different error
// envelope than the read endpoints — `{ status: "error", message }` with no
// `errorType`. Map those by HTTP status; 5xx and unknown fall through to
// upstream_failure so the internal-exception sanitisation below is preserved.
function categoryForStatus(status: number | undefined): ErrorCategory | undefined {
	switch (status) {
		case 400:
			return 'invalid_input';
		case 403:
			return 'permission_denied';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		case 422:
			return 'invalid_input';
		case 429:
			return 'rate_limited';
		default:
			return undefined;
	}
}

function restBaseFrom(apiUrl: string): string {
	// apiUrl is `${server}${scriptpath}/api.php`; NeoWiki REST lives at
	// `${server}${scriptpath}/rest.php/neowiki/v0` — same origin, so the bearer
	// and cookies that reach the action API also reach here.
	return `${apiUrl.replace(/\/api\.php$/, '/rest.php')}/neowiki/v0`;
}

export async function neowikiRequest(mwn: Mwn, spec: NeoWikiRequestSpec): Promise<unknown> {
	const apiUrl = mwn.options.apiUrl;
	if (typeof apiUrl !== 'string' || !/\/api\.php$/.test(apiUrl)) {
		throw new ClassifiedError(
			'upstream_failure',
			'Cannot derive the NeoWiki REST base from the wiki API URL.',
		);
	}

	let url = `${restBaseFrom(apiUrl)}${spec.path}`;
	if (spec.query !== undefined && Object.keys(spec.query).length > 0) {
		url += `?${new URLSearchParams(spec.query).toString()}`;
	}

	const headers: Record<string, string> = {
		Accept: 'application/json',
		...wikiAuthorization(mwn, url),
	};
	if (spec.body !== undefined) {
		headers['Content-Type'] = 'application/json';
	}
	if (spec.csrf === true) {
		headers['X-CSRF-TOKEN'] = await mwn.getCsrfToken();
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
		// The server's own verdict, not the wiki's: relabelling it as a pack error
		// would lose the code and, on writes, the dispatcher's caveat.
		if (err instanceof WikiTimeoutError) {
			throw err;
		}
		throw classifyNeoWikiError(err);
	}
}

function classifyNeoWikiError(err: unknown): ClassifiedError {
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
			return new ClassifiedError(category, message, status);
		}

		// MediaWiki REST envelope, from parameter validation or a read denial:
		// { error, messageTranslations?: { en } }.
		if (typeof record.error === 'string') {
			const translations = record.messageTranslations;
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- messageTranslations sub-object shape at this boundary
			const en =
				translations !== null && typeof translations === 'object'
					? (translations as { en?: unknown }).en
					: undefined;
			const message = typeof en === 'string' ? en : record.error;
			return new ClassifiedError(categoryForStatus(status) ?? 'invalid_input', message, status);
		}

		// Internal RuntimeException: { message, exception: {…backtrace…} }.
		// Surface the message only — never the backtrace. A refused write also
		// lists its violations, which say what to fix.
		if (typeof record.message === 'string') {
			const message = Array.isArray(record.violations)
				? `${record.message}: ${JSON.stringify(record.violations)}`
				: record.message;
			return new ClassifiedError(categoryForStatus(status) ?? 'upstream_failure', message, status);
		}
	}

	// Bodyless / unrecognised-shape responses: map by HTTP status the same way as
	// the message-bearing branch above, so the two paths can't disagree.
	const statusCategory = categoryForStatus(status);
	if (statusCategory !== undefined) {
		return new ClassifiedError(statusCategory, `NeoWiki request failed (HTTP ${status}).`, status);
	}

	// Covers both axios network errors (no .response — timeout, ECONNREFUSED) and unrecognised body shapes.
	const message = errorMessage(err);
	return new ClassifiedError('upstream_failure', message, status);
}
