import { describe, it, expect } from 'vitest';
import { contextReturning, requestedUrl } from '../../../helpers/rawRequest.ts';
import { neowikiGetReferencingSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-get-referencing-subjects.ts';

const employee = {
	id: 's1demo2bbbbbbb2',
	label: 'Ada',
	displayName: 'Ada',
	displayNameIsGenerated: false,
	schema: 'Person',
	pageId: 8,
	pageTitle: 'Ada',
	statements: { Employer: { propertyType: 'relation', value: [{ target: 's1demo1aaaaaaa1' }] } },
};

describe('neowiki-get-referencing-subjects', () => {
	it("asks for the subjects that point at the subject, up to the endpoint's maximum of 50", async () => {
		const { mock, ctx } = contextReturning({ referencingSubjects: [], truncated: false });

		await neowikiGetReferencingSubjects.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		const url = requestedUrl(mock);
		expect(url.pathname).toBe('/w/rest.php/neowiki/v0/subject/s1demo1aaaaaaa1/referencingSubjects');
		expect(url.searchParams.get('limit')).toBe('50');
	});

	it('returns each referencing subject, as neowiki-get-subject does, with the properties that point', async () => {
		const { ctx } = contextReturning({
			referencingSubjects: [{ subject: employee, propertyNames: ['Employer'] }],
			truncated: false,
		});

		const result = await neowikiGetReferencingSubjects.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect(result.structuredContent).toEqual({
			referencingSubjects: [
				{
					subject: {
						id: 's1demo2bbbbbbb2',
						label: 'Ada',
						displayName: 'Ada',
						schema: 'Person',
						pageId: 8,
						pageTitle: 'Ada',
						statements: employee.statements,
					},
					propertyNames: ['Employer'],
				},
			],
		});
	});

	it('marks a list NeoWiki cut short as capped', async () => {
		const { ctx } = contextReturning({
			referencingSubjects: [{ subject: employee, propertyNames: ['Employer'] }],
			truncated: true,
		});

		const result = await neowikiGetReferencingSubjects.handle({ id: 's1demo1aaaaaaa1' }, ctx);

		expect(result.structuredContent).toMatchObject({
			truncation: { reason: 'capped-no-continuation', returnedCount: 1, limit: 50 },
		});
	});
});
