import { z } from 'zod';
import { ClassifiedError } from '../errors/classifyError.ts';
import type { TruncationInfo } from './truncation.ts';
import { capLinesByBytes } from './truncation.ts';

/** The most rows a SPARQL tool hands back, also where the caller sets no limit. */
export const SPARQL_ROW_CAP = 1000;

/**
 * Result bytes read into memory. A store answers an unbounded query with an unbounded result set,
 * and the row cap applies only once the whole envelope has been parsed, so this is what stands
 * between a missing LIMIT and the server's heap.
 */
export const MAX_SPARQL_RESULT_BYTES = 10 * 1024 * 1024;

/** The `limit` parameter of a SPARQL tool whose queries `computer`, such as "the store", runs. */
export function sparqlLimitSchema(computer: string): z.ZodOptional<z.ZodNumber> {
	return z
		.number()
		.int()
		.min(1)
		.max(SPARQL_ROW_CAP)
		.optional()
		.describe(
			`Maximum rows to return. Caps what is handed back, not what ${computer} computes — add LIMIT to the query itself to spare it the work. Hard cap ${SPARQL_ROW_CAP}, which also applies when omitted.`,
		);
}

/** What a SPARQL tool says when `source` answers with more than MAX_SPARQL_RESULT_BYTES. */
export function sparqlResultsTooLarge(source: string): string {
	return `${source} returned more than ${MAX_SPARQL_RESULT_BYTES / (1024 * 1024)} MB of results. Add LIMIT to the query, or project fewer variables.`;
}

/** A line break inside a cell, which `GROUP_CONCAT` puts there routinely. */
const LINE_BREAK = /\r\n|[\r\n]/g;

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

/** The solutions of a W3C SPARQL JSON results document that `source` answered with, failing for anything else. */
export function sparqlResultsOf(envelope: unknown, maxRows: number, source: string): SparqlResults {
	const results = solutionsOf(envelope, maxRows);
	if (results === null) {
		throw notSparqlResults(source);
	}
	return results;
}

export function notSparqlResults(source: string): ClassifiedError {
	return new ClassifiedError(
		'upstream_failure',
		`${source} returned a response that is not SPARQL JSON results.`,
	);
}

function solutionsOf(envelope: unknown, maxRows: number): SparqlResults | null {
	if (typeof envelope !== 'object' || envelope === null) {
		return null;
	}
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SPARQL results envelope; shape is checked below
	const parsed = envelope as SparqlJson;

	if (typeof parsed.boolean === 'boolean') {
		return { columns: [], rows: [], totalRows: 0, boolean: parsed.boolean };
	}

	const vars = parsed.head?.vars;
	const bindings = parsed.results?.bindings;
	if (!Array.isArray(vars) || !Array.isArray(bindings)) {
		return null;
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

/** What a SPARQL query tool returns: an ASK query's boolean, or the rows under the byte cap. */
export function sparqlToolResult(
	results: SparqlResults,
	limit: number,
	toolName: string,
): { boolean: boolean } | { columns: string[]; rows: string[]; truncation?: TruncationInfo } {
	if (results.boolean !== undefined) {
		return { boolean: results.boolean };
	}

	const byteCapped = capLinesByBytes(results.rows);

	return {
		columns: results.columns,
		rows: byteCapped.lines,
		...truncationOf(byteCapped, results.totalRows, limit, toolName),
	};
}

function truncationOf(
	capped: { lines: string[]; returnedBytes: number; totalBytes: number; truncated: boolean },
	totalRows: number,
	limit: number,
	toolName: string,
): { truncation?: TruncationInfo } {
	if (capped.truncated) {
		return {
			truncation: {
				reason: 'content-truncated',
				returnedBytes: capped.returnedBytes,
				totalBytes: capped.totalBytes,
				itemNoun: 'rows',
				toolName,
				// A byte-truncated response that also hit the row cap leaves a caller
				// told only about the bytes believing the rest is one page away.
				remedyHint:
					totalRows > limit
						? `To read the rest of the ${totalRows} rows the query matched (${capped.lines.length} delivered before the byte cap), narrow the projection or page with LIMIT and OFFSET.`
						: 'To read the rest, narrow the projection or page with LIMIT and OFFSET.',
			},
		};
	}
	if (totalRows > limit) {
		return {
			truncation: {
				reason: 'capped-no-continuation',
				returnedCount: limit,
				limit,
				itemNoun: 'rows',
				narrowHint: `the query matched ${totalRows} — page through them with LIMIT and OFFSET in the query.`,
			},
		};
	}
	return {};
}
