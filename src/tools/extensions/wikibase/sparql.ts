import type { ErrorCategory } from '../../../errors/classifyError.ts';
import { FileTooLargeError, HttpStatusError, postForm } from '../../../transport/httpFetch.ts';
import { getRequestSignal } from '../../../runtime/requestContext.ts';

/** Matches the query timeout most Wikibase query services enforce themselves. */
const QUERY_TIMEOUT_MS = 60_000;

/**
 * Result bytes read into memory. A query service answers an unbounded query with
 * an unbounded result set, and the row cap applies only once the whole envelope
 * has been parsed, so this is what stands between a missing LIMIT and the
 * server's heap.
 */
const MAX_RESULT_BYTES = 10 * 1024 * 1024;

/** Characters of a query service's own error text passed back to the caller. */
const MAX_SERVICE_MESSAGE_CHARS = 500;

/** A line break inside a cell, which `GROUP_CONCAT` puts there routinely. */
const LINE_BREAK = /\r\n|[\r\n]/g;

/** A query service failure already classified into an MCP error category. */
export class SparqlError extends Error {
	public constructor(
		public readonly category: ErrorCategory,
		message: string,
	) {
		super(message);
		this.name = 'SparqlError';
	}
}

export interface SparqlResults {
	columns: string[];
	/** One line per solution, cells joined with ` | ` in column order. At most `maxRows`. */
	rows: string[];
	/** Solutions the service returned, which is what `rows` was cut down from. */
	totalRows: number;
	/** Set instead of rows for an ASK query. */
	boolean?: boolean;
}

interface SparqlJson {
	head?: { vars?: unknown };
	results?: { bindings?: unknown };
	boolean?: unknown;
}

export async function runSparqlQuery(
	endpoint: string,
	query: string,
	maxRows: number,
): Promise<SparqlResults> {
	let body: string;
	try {
		body = await postForm(
			endpoint,
			{ query },
			{
				headers: { Accept: 'application/sparql-results+json' },
				signal: querySignal(),
				maxBytes: MAX_RESULT_BYTES,
			},
		);
	} catch (err) {
		throw classifyQueryFailure(err, endpoint);
	}
	return parseResults(body, maxRows);
}

// Bounded by the service's own limit, and cancelled with the MCP request so a
// client that walks away does not leave a minute-long query running.
function querySignal(): AbortSignal {
	const timeout = AbortSignal.timeout(QUERY_TIMEOUT_MS);
	const request = getRequestSignal();
	return request === undefined ? timeout : AbortSignal.any([timeout, request]);
}

function parseResults(body: string, maxRows: number): SparqlResults {
	let envelope: unknown;
	try {
		envelope = JSON.parse(body);
	} catch {
		throw notSparqlResults();
	}
	// A body of `null` parses, and reading a property off it throws. This runs
	// outside the catch that classifies failures, so that TypeError would reach
	// the caller unclassified.
	if (typeof envelope !== 'object' || envelope === null) {
		throw notSparqlResults();
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SPARQL results envelope; shape is checked below
	const parsed = envelope as SparqlJson;

	if (typeof parsed.boolean === 'boolean') {
		return { columns: [], rows: [], totalRows: 0, boolean: parsed.boolean };
	}

	const vars = parsed.head?.vars;
	const bindings = parsed.results?.bindings;
	if (!Array.isArray(vars) || !Array.isArray(bindings)) {
		throw notSparqlResults();
	}

	const columns = vars.filter((name): name is string => typeof name === 'string');
	// Cut to the row cap before rendering: the solutions past it reach no one, and
	// a service answering an unLIMITed query returns them by the hundred thousand.
	return {
		columns,
		rows: bindings.slice(0, maxRows).map((binding) => renderRow(binding, columns)),
		totalRows: bindings.length,
	};
}

function notSparqlResults(): SparqlError {
	return new SparqlError(
		'upstream_failure',
		'The query service returned a response that is not SPARQL JSON results.',
	);
}

// Unbound variables keep their column as an empty cell: dropping them would
// shift every later cell one column left. Line breaks inside a cell become
// spaces, since a solution is a line.
function renderRow(binding: unknown, columns: string[]): string {
	const cells = typeof binding === 'object' && binding !== null ? binding : {};
	return columns
		.map((column) => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SPARQL binding term; narrowed to read `value`
			const term = (cells as Record<string, { value?: unknown } | undefined>)[column];
			return typeof term?.value === 'string' ? term.value.replace(LINE_BREAK, ' ') : '';
		})
		.join(' | ');
}

function classifyQueryFailure(err: unknown, endpoint: string): SparqlError {
	if (err instanceof HttpStatusError) {
		return new SparqlError(categoryForStatus(err.status), serviceMessage(err, endpoint));
	}
	if (err instanceof FileTooLargeError) {
		return new SparqlError(
			'invalid_input',
			`The query service returned more than ${MAX_RESULT_BYTES / (1024 * 1024)} MB of results. Add LIMIT to the query, or project fewer variables.`,
		);
	}
	if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
		return new SparqlError(
			'upstream_failure',
			`The query service did not answer within ${QUERY_TIMEOUT_MS / 1000} seconds.`,
		);
	}
	const message = err instanceof Error ? err.message : String(err);
	return new SparqlError('upstream_failure', withoutEndpoint(message, endpoint));
}

/**
 * The endpoint named rather than quoted. A transport error quotes the URL it
 * failed on, and a query service echoes the request URI into its own error page.
 * That URL is the operator's to know: it can carry a token in its path or query,
 * and it reaches the caller and the logs from here.
 */
function withoutEndpoint(message: string, endpoint: string): string {
	return endpoint === '' ? message : message.split(endpoint).join("the wiki's query service");
}

function categoryForStatus(status: number): ErrorCategory {
	switch (status) {
		case 400:
			return 'invalid_input';
		case 401:
			return 'authentication';
		case 403:
			return 'permission_denied';
		case 429:
			return 'rate_limited';
		default:
			return 'upstream_failure';
	}
}

// Query services answer a bad query with their engine's own diagnostics, which
// run to dozens of lines of parser expectations. The leading lines carry the
// actual complaint. The endpoint goes before the cut, so that cutting cannot
// leave a fragment of it standing.
function serviceMessage(err: HttpStatusError, endpoint: string): string {
	const body = withoutEndpoint(err.body?.trim() ?? '', endpoint);
	if (body === '') {
		return `The query service rejected the request (HTTP ${err.status}).`;
	}
	const summary = body
		.split('\n')
		.map((line) => line.trim())
		.filter((line) => line !== '')
		.slice(0, 5)
		.join(' ');
	return summary.length > MAX_SERVICE_MESSAGE_CHARS
		? `${summary.slice(0, MAX_SERVICE_MESSAGE_CHARS)}…`
		: summary;
}
