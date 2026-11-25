import { describe, it, expect } from 'vitest';
import { sparqlResultsOf } from '../../src/results/sparqlResults.ts';

const SOURCE = 'The store';
const MANY_ROWS = 1000;

function selectResults(bindings: unknown[], vars: string[] = ['item']): unknown {
	return { head: { vars }, results: { bindings } };
}

function rowBindings(count: number): unknown[] {
	return Array.from({ length: count }, (_, i) => ({ item: { type: 'uri', value: `urn:${i}` } }));
}

function thrownBy(run: () => unknown): unknown {
	try {
		run();
	} catch (err) {
		return err;
	}
	return undefined;
}

function rowsOf(envelope: unknown): string[] {
	return sparqlResultsOf(envelope, MANY_ROWS, SOURCE).rows;
}

describe('sparqlResultsOf', () => {
	it('renders the bindings as pipe-separated rows in column order', () => {
		const envelope = selectResults(
			[{ item: { type: 'uri', value: 'urn:cat' }, itemLabel: { type: 'literal', value: 'Gli' } }],
			['item', 'itemLabel'],
		);

		expect(sparqlResultsOf(envelope, MANY_ROWS, SOURCE)).toMatchObject({
			columns: ['item', 'itemLabel'],
			rows: ['urn:cat | Gli'],
			totalRows: 1,
		});
	});

	it('leaves an unbound cell empty rather than dropping the column', () => {
		expect(
			rowsOf(selectResults([{ item: { type: 'uri', value: 'urn:x' } }], ['item', 'itemLabel'])),
		).toEqual(['urn:x | ']);
	});

	it('leaves a term without a string value as an empty cell', () => {
		expect(
			rowsOf(
				selectResults([{ item: { type: 'uri' }, itemLabel: { value: 42 } }], ['item', 'itemLabel']),
			),
		).toEqual([' | ']);
	});

	// GROUP_CONCAT with a newline separator is standard SPARQL, and a cell holding
	// one would otherwise break the one-line-per-solution contract.
	it('collapses line breaks inside a cell so one solution stays one line', () => {
		expect(
			rowsOf(selectResults([{ item: { type: 'literal', value: 'Gli\nRoma\r\nMuseo\rDoria' } }])),
		).toEqual(['Gli Roma Museo Doria']);
	});

	it('collapses line breaks in every cell, not only the first one it meets', () => {
		const envelope = selectResults(
			[
				{ item: { type: 'literal', value: 'a\nb' }, other: { type: 'literal', value: 'c\nd' } },
				{ item: { type: 'literal', value: 'e\nf' }, other: { type: 'literal', value: 'g\nh' } },
			],
			['item', 'other'],
		);

		expect(rowsOf(envelope)).toEqual(['a b | c d', 'e f | g h']);
	});

	it('renders only the rows asked for, and reports how many matched', () => {
		const results = sparqlResultsOf(selectResults(rowBindings(500)), 3, SOURCE);

		expect(results.rows).toEqual(['urn:0', 'urn:1', 'urn:2']);
		expect(results.totalRows).toBe(500);
	});

	it('reports an ASK result as a boolean', () => {
		expect(sparqlResultsOf({ head: {}, boolean: false }, MANY_ROWS, SOURCE)).toMatchObject({
			boolean: false,
		});
	});

	it.each([
		['null', null],
		['an object without solutions', { rows: [] }],
	])('refuses %s as not SPARQL results, naming what answered', (_, envelope) => {
		const err = thrownBy(() => sparqlResultsOf(envelope, MANY_ROWS, SOURCE));

		expect(err).toMatchObject({
			category: 'upstream_failure',
			message: 'The store returned a response that is not SPARQL JSON results.',
		});
	});
});
