import { describe, it, expect } from 'vitest';
import { contextReturning, requestedUrl } from '../../../helpers/rawRequest.ts';
import { neowikiSearchSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-search-subjects.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

function matches(count: number): Array<{ id: string; label: string }> {
	return Array.from({ length: count }, (_, i) => ({ id: `s${i}`, label: `A${i}` }));
}

describe('neowiki-search-subjects', () => {
	it('passes schema and search and returns matches', async () => {
		const { mock, ctx } = contextReturning([{ id: 's1demo1aaaaaaa1', label: 'ACME Inc' }]);
		const result = await neowikiSearchSubjects.handle({ schema: ['Company'], search: 'a' }, ctx);

		const url = requestedUrl(mock);
		expect(url.pathname).toBe('/w/rest.php/neowiki/v0/subject-labels');
		expect(url.searchParams.get('schema')).toBe('Company');
		expect(url.searchParams.get('search')).toBe('a');
		expect(result.structuredContent).toMatchObject({ subjects: [{ id: 's1demo1aaaaaaa1' }] });
	});

	it("returns each subject's name as its displayName, which is not its label", async () => {
		const { ctx } = contextReturning([
			{ id: 's1demo1aaaaaaa1', label: 'ACME', pageTitle: 'ACME (company)' },
		]);
		const result = await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(result.structuredContent).toEqual({
			subjects: [{ id: 's1demo1aaaaaaa1', displayName: 'ACME', pageTitle: 'ACME (company)' }],
		});
	});

	it('searches several schemas at once', async () => {
		const { mock, ctx } = contextReturning([]);
		await neowikiSearchSubjects.handle({ schema: ['Person', 'Group'], search: 'a' }, ctx);

		expect(requestedUrl(mock).searchParams.get('schema')).toBe('Person|Group');
	});

	it('lists the subjects of the given schemas when there is no search', async () => {
		const { mock, ctx } = contextReturning([]);
		await neowikiSearchSubjects.handle({ schema: ['Material'] }, ctx);

		const params = requestedUrl(mock).searchParams;
		expect(params.get('schema')).toBe('Material');
		expect(params.has('search')).toBe(false);
	});

	it('refuses a call with neither a search nor a schema', async () => {
		const { mock, ctx } = contextReturning([]);
		const result = await neowikiSearchSubjects.handle({}, ctx);

		assertStructuredError(result, 'invalid_input');
		expect(mock.rawRequest).not.toHaveBeenCalled();
	});

	it('searches every schema when none is given', async () => {
		const { mock, ctx } = contextReturning([]);
		await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(requestedUrl(mock).searchParams.has('schema')).toBe(false);
	});

	it("asks for the endpoint's maximum of 50 matches", async () => {
		const { mock, ctx } = contextReturning([]);
		await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(requestedUrl(mock).searchParams.get('limit')).toBe('50');
	});

	it('does not mark a result below the limit as capped', async () => {
		const { ctx } = contextReturning(matches(49));
		const result = await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(result.structuredContent).not.toHaveProperty('truncation');
	});

	it('marks a result that fills the limit as capped', async () => {
		const { ctx } = contextReturning(matches(50));
		const result = await neowikiSearchSubjects.handle({ search: 'a' }, ctx);

		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'capped-no-continuation', returnedCount: 50, limit: 50 },
		});
	});

	it('returns an empty list when the response is not an array', async () => {
		const { ctx } = contextReturning({});
		const result = await neowikiSearchSubjects.handle({ schema: ['Company'], search: 'zzz' }, ctx);

		expect(result.structuredContent).toMatchObject({ subjects: [] });
	});
});
