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
	 * reads and the endpoints that take no token: the `validate` dry-runs and minting IDs.
	 */
	readonly csrf?: boolean;
	/** What the error says where the wiki serves no such endpoint, as for a store it lacks. */
	readonly unavailable?: string;
	/** The most bytes of an answer to read, for an endpoint that bounds none, and what the error says past them. */
	readonly sizeCap?: { readonly bytes: number; readonly exceeded: string };
}

// NeoWiki's `errorType` strings are stable across releases (per query-api docs);
// branch on them, never on the translated `message`.
const ERROR_TYPE_TO_CATEGORY: Record<string, ErrorCategory> = {
	emptyQuery: 'invalid_input',
	parameterMissing: 'invalid_input',
	cypherSyntaxError: 'invalid_input',
	sparqlSyntaxError: 'invalid_input',
	writeQueryRejected: 'invalid_input',
	queryTimeout: 'upstream_failure',
	rateLimitExceeded: 'rate_limited',
	permissionDenied: 'permission_denied',
	backendUnavailable: 'upstream_failure',
	sparqlStoreUnavailable: 'upstream_failure',
	internalError: 'upstream_failure',
};

/** What an HTTP status tells the caller, for an error that names no errorType. */
function categoryForStatus(status: number): ErrorCategory {
	switch (status) {
		case 401:
			return 'authentication';
		case 403:
			return 'permission_denied';
		case 404:
			return 'not_found';
		case 409:
			return 'conflict';
		case 429:
			return 'rate_limited';
		default:
			return status >= 400 && status < 500 ? 'invalid_input' : 'upstream_failure';
	}
}

function restBaseFrom(apiUrl: string): string {
	// apiUrl is `${server}${scriptpath}/api.php`; NeoWiki REST lives at
	// `${server}${scriptpath}/rest.php/neowiki/v0` — same origin, so the bearer
	// and cookies that reach the action API also reach here.
	return `${apiUrl.replace(/\/api\.php$/, '/rest.php')}/neowiki/v0`;
}

/** The response body, in the shape `T` the endpoint documents: trusted, not checked. */
export async function neowikiRequest<T = unknown>(mwn: Mwn, spec: NeoWikiRequestSpec): Promise<T> {
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
			...(spec.sizeCap !== undefined ? { maxContentLength: spec.sizeCap.bytes } : {}),
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the endpoint's documented body, which T names
		return (response as { data: T }).data;
	} catch (err: unknown) {
		// The server's own verdict, not the wiki's: relabelling it as a pack error
		// would lose the code and, on writes, the dispatcher's caveat.
		if (err instanceof WikiTimeoutError) {
			throw err;
		}
		throw classifyNeoWikiError(err, spec);
	}
}

function classifyNeoWikiError(err: unknown, spec: NeoWikiRequestSpec): ClassifiedError {
	// axios refuses an answer past `maxContentLength` with this message and no response.
	if (spec.sizeCap !== undefined && /maxContentLength/.test(errorMessage(err))) {
		return new ClassifiedError('invalid_input', spec.sizeCap.exceeded);
	}

	// axios throws on non-2xx with `err.response.{status,data}`.
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios error shape at this boundary
	const response = (err as { response?: { status?: number; data?: unknown } }).response;
	const status = response?.status;
	// A network error, such as a timeout or a refused connection, has no response.
	if (status === undefined) {
		return new ClassifiedError('upstream_failure', errorMessage(err));
	}

	const record = recordOf(response?.data);

	// MediaWiki's answer for a path no handler serves: an endpoint this NeoWiki lacks.
	if (record?.errorKey === 'rest-no-match') {
		const message = spec.unavailable ?? `The wiki's NeoWiki has no ${spec.path} endpoint.`;
		return new ClassifiedError('invalid_input', message, status);
	}

	const errorType = typeof record?.errorType === 'string' ? record.errorType : undefined;
	const category =
		(errorType !== undefined ? ERROR_TYPE_TO_CATEGORY[errorType] : undefined) ??
		categoryForStatus(status);
	const message = (record !== undefined ? reasonIn(record) : undefined) ?? errorType;

	return new ClassifiedError(
		category,
		message ?? `NeoWiki request failed (HTTP ${status}).`,
		status,
	);
}

function recordOf(data: unknown): Record<string, unknown> | undefined {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- verified non-null object; narrowed to inspect keys
	return data !== null && typeof data === 'object' ? (data as Record<string, unknown>) : undefined;
}

/**
 * The reason an error body gives: MediaWiki REST's English message or error code, else NeoWiki's
 * message with the violations of a refused write. Never an internal exception's backtrace.
 */
function reasonIn(record: Record<string, unknown>): string | undefined {
	const translations = recordOf(record.messageTranslations);
	if (typeof translations?.en === 'string') {
		return translations.en;
	}
	if (typeof record.error === 'string') {
		return record.error;
	}
	if (typeof record.message === 'string') {
		return Array.isArray(record.violations)
			? `${record.message}: ${JSON.stringify(record.violations)}`
			: record.message;
	}
	return undefined;
}
