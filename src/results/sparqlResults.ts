import type { TruncationInfo } from './truncation.ts';
import { capLinesByBytes } from './truncation.ts';

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

/** The solutions of a W3C SPARQL JSON results document; null for anything that is not one. */
export function sparqlResultsFrom(envelope: unknown, maxRows: number): SparqlResults | null {
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
