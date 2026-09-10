import { describe, it, expect } from 'vitest';
import { truncationSentence } from '../../src/results/truncation.ts';
import { structuredResult } from '../../src/results/response.ts';
import { assertStructuredSuccess } from '../helpers/structuredResult.ts';

describe('truncationSentence', () => {
	it('states the call that fetches the next segment', () => {
		expect(
			truncationSentence({
				reason: 'more-available',
				returnedCount: 50,
				itemNoun: 'revisions',
				toolName: 'get-page-history',
				continueWith: { param: 'olderThan', value: '2026-01-01T00:00:00Z' },
			}),
		).toBe(
			'More revisions available; 50 returned. To fetch the next segment, call get-page-history again with olderThan=2026-01-01T00:00:00Z.',
		);
	});

	it('states the cap and the narrowing when there is no continuation', () => {
		expect(
			truncationSentence({
				reason: 'capped-no-continuation',
				returnedCount: 50,
				limit: 50,
				itemNoun: 'results',
				narrowHint: 'refine the search terms.',
			}),
		).toBe(
			'Capped at the results limit of 50; 50 returned. Additional results may exist — refine the search terms.',
		);
	});

	it('states the bytes, the narrower targets and the remedy', () => {
		expect(
			truncationSentence({
				reason: 'content-truncated',
				returnedBytes: 75000,
				totalBytes: 129723,
				itemNoun: 'wikitext',
				toolName: 'get-page',
				sections: ['2 (Origins)', '3 (Modern era)'],
				remedyHint:
					'To read part of this section, call get-page again with one of the subsection numbers listed.',
			}),
		).toBe(
			'Content (wikitext) truncated at 75000 of 129723 bytes. Available sections: 2 (Origins), 3 (Modern era). To read part of this section, call get-page again with one of the subsection numbers listed.',
		);
	});

	it('leaves out the section clause when there are no narrower targets', () => {
		const sentence = truncationSentence({
			reason: 'content-truncated',
			returnedBytes: 75000,
			totalBytes: 129723,
			itemNoun: 'wikitext',
			toolName: 'get-page',
			remedyHint: 'No narrower read returns more of this section.',
		});

		expect(sentence).not.toContain('Available sections');
		expect(sentence).toBe(
			'Content (wikitext) truncated at 75000 of 129723 bytes. No narrower read returns more of this section.',
		);
	});

	// Every itemNoun is plural, so a count must never modify one directly.
	it('reads correctly when one item was returned', () => {
		expect(
			truncationSentence({
				reason: 'more-available',
				returnedCount: 1,
				itemNoun: 'pages',
				toolName: 'get-pages',
				continueWith: { param: 'titles', value: 'Amsterdam|Antwerp' },
			}),
		).toContain('More pages available; 1 returned.');
	});
});

describe('truncation in a result', () => {
	const marker = {
		reason: 'more-available' as const,
		returnedCount: 50,
		itemNoun: 'revisions',
		toolName: 'get-page-history',
		continueWith: { param: 'olderThan', value: '2026-01-01T00:00:00Z' },
	};

	it('renders the sentence in the prose channel and keeps the object in the typed one', () => {
		const result = structuredResult({ title: 'Japan', truncation: marker });

		expect(assertStructuredSuccess(result)).toContain(
			'Truncation: More revisions available; 50 returned.',
		);
		expect(result.structuredContent).toEqual({ title: 'Japan', truncation: marker });
	});

	// The sentence runs past the length at which a value becomes its own block,
	// which would put it at column 0, outside the entry it belongs to.
	it('keeps a nested marker on its own label line, indented under its entry', () => {
		const result = structuredResult({
			pages: [{ title: 'Big', truncation: { ...marker, itemNoun: 'wikitext' } }],
		});

		expect(assertStructuredSuccess(result)).toContain('  Truncation: More wikitext available;');
	});

	it('leaves a truncation field that is not a marker alone', () => {
		const result = structuredResult({ truncation: { reason: 'something else', n: 1 } });

		expect(assertStructuredSuccess(result)).toContain('Reason: something else');
	});
});
