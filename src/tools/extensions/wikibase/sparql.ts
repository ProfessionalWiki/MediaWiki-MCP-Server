import type { ErrorCategory } from '../../../errors/classifyError.ts';
import { FileTooLargeError, HttpStatusError, postForm } from '../../../transport/httpFetch.ts';
import { RedirectDropsBodyError } from '../../../transport/requestChain.ts';
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

/** An absolute URL sitting in a message, running to the first space. */
const ABSOLUTE_URL = /https?:\/\/\S+/g;

/**
 * What a URL is called once the parts that can hold a token are gone. Reads as
 * the subject of the sentence a transport error puts it in.
 */
const QUERY_SERVICE = "the wiki's query service";

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
	if (err instanceof RedirectDropsBodyError) {
		return new SparqlError(
			'upstream_failure',
			`The query service redirected the query to ${originOf(err.target)} instead of answering it (HTTP ${err.status}), and a SPARQL query cannot survive that redirect. The wiki advertises this endpoint in its siteinfo as \`wikibase-sparql\`, so its operator has to point that at an address which answers directly.`,
		);
	}
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
	return new SparqlError('upstream_failure', transportMessage(message, endpoint));
}

/**
 * Scheme and host of a redirect target, without its path or query. A target
 * derived from the endpoint inherits whatever the endpoint carries, and differing
 * in scheme it is not a substring `withoutEndpoint` can find — so the parts that
 * can hold a token are dropped rather than substituted. Scheme and host are what
 * an operator needs to recognise the redirect, and hold no credentials.
 */
function originOf(target: string): string {
	return new URL(target).origin;
}

/**
 * A message this server wrote about a request it made itself, with every URL in
 * it cut back. Substituting the endpoint would reach only the endpoint: a 307 or
 * 308 is followed, and a relative Location resolves against the endpoint's path,
 * so the hop after it fails on a URL that carries the endpoint's token under a
 * spelling no substitution finds. Reading each URL for what it is catches the
 * endpoint too, so the substitution has no work left to do here.
 *
 * Only this server's own messages come through here. A query service's
 * diagnostics are the caller's IRIs quoted back, and cutting those back would
 * answer a malformed query by deleting the term it complained about.
 */
function transportMessage(message: string, endpoint: string): string {
	const service = endpointOrigin(endpoint);
	return message.replace(ABSOLUTE_URL, (url) => urlAsRead(url, service));
}

/**
 * The origin the endpoint's own URLs carry, or nothing when the wiki published an
 * address that is not one. Read the way the transport reads it, since a wiki
 * names a server it answers under either scheme without a scheme of its own.
 */
function endpointOrigin(endpoint: string): string | undefined {
	try {
		return originOf(endpoint.startsWith('//') ? `https:${endpoint}` : endpoint);
	} catch {
		return undefined;
	}
}

/**
 * A URL from the endpoint's own origin is the endpoint reached by another path,
 * and is named as one. Any other keeps its origin, which is how an operator sees
 * the host a redirect went to, or the host to add to `MCP_TRUSTED_HOSTS`. What
 * does not parse cannot be cut back, so it goes entirely.
 */
function urlAsRead(url: string, service: string | undefined): string {
	try {
		const origin = originOf(url);
		return origin === service ? QUERY_SERVICE : origin;
	} catch {
		return QUERY_SERVICE;
	}
}

/**
 * The endpoint named rather than quoted, for the query service's own error page,
 * which echoes the request URI into it. That URL is the operator's to know: it
 * can carry a token in its path or query, and it reaches the caller and the logs
 * from here.
 */
function withoutEndpoint(message: string, endpoint: string): string {
	return endpoint === '' ? message : message.split(endpoint).join(QUERY_SERVICE);
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
