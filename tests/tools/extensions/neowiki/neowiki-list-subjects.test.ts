import { describe, it, expect } from 'vitest';
import { contextReturning, requestedUrl } from '../../../helpers/rawRequest.ts';
import { neowikiListSubjects } from '../../../../src/tools/extensions/neowiki/neowiki-list-subjects.ts';

const acme = {
	id: 's1demo1aaaaaaa1',
	displayName: 'ACME',
	displayNameIsGenerated: false,
	schema: 'Company',
	pageId: 7,
	pageTitle: 'ACME',
	lastEdited: '2026-11-20T10:00:00Z',
};

describe('neowiki-list-subjects', () => {
	it('requests the newest 50 subjects by default', async () => {
		const { mock, ctx } = contextReturning({ subjects: [], nextCursor: null });

		await neowikiListSubjects.handle({}, ctx);

		const url = requestedUrl(mock);
		expect(url.pathname).toBe('/w/rest.php/neowiki/v0/subjects');
		expect(url.searchParams.get('limit')).toBe('50');
		expect(url.searchParams.has('sort')).toBe(false);
		expect(url.searchParams.has('cursor')).toBe(false);
	});

	it('passes the schema, search and order it is given', async () => {
		const { mock, ctx } = contextReturning({ subjects: [], nextCursor: null });

		await neowikiListSubjects.handle(
			{ schema: 'Company', search: 'acm', sort: 'name', direction: 'desc' },
			ctx,
		);

		const params = requestedUrl(mock).searchParams;
		expect(params.get('schema')).toBe('Company');
		expect(params.get('search')).toBe('acm');
		expect(params.get('sort')).toBe('name');
		expect(params.get('direction')).toBe('desc');
	});

	it('returns the subjects, flagging only a display name that is generated', async () => {
		const { ctx } = contextReturning({
			subjects: [acme, { ...acme, id: 's1demo1aaaaaaa2', displayNameIsGenerated: true }],
			nextCursor: null,
		});

		const result = await neowikiListSubjects.handle({}, ctx);

		const { displayNameIsGenerated: _, ...named } = acme;
		expect(result.structuredContent).toEqual({
			subjects: [named, { ...named, id: 's1demo1aaaaaaa2', displayNameIsGenerated: true }],
		});
	});

	it('flags the generated name of a host subject the same way', async () => {
		const host = {
			id: 's1demo1aaaaaaa1',
			displayName: 'Pablo Picasso',
			displayNameIsGenerated: false,
			schema: 'Person',
		};
		const { ctx } = contextReturning({
			subjects: [{ ...acme, schema: 'Birth', displayNameIsGenerated: true, hostSubject: host }],
			nextCursor: null,
		});

		const result = await neowikiListSubjects.handle({ schema: 'Birth' }, ctx);

		const [row] = (result.structuredContent as { subjects: Array<{ hostSubject?: unknown }> })
			.subjects;
		expect(row.hostSubject).toEqual({
			id: 's1demo1aaaaaaa1',
			displayName: 'Pablo Picasso',
			schema: 'Person',
		});
	});

	it('hands back the next cursor as continueFrom while more subjects remain', async () => {
		const { ctx } = contextReturning({ subjects: [acme], nextCursor: 'c2' });

		const result = await neowikiListSubjects.handle({}, ctx);

		expect(result.structuredContent).toMatchObject({
			truncation: {
				reason: 'more-available',
				continueWith: { param: 'continueFrom', value: 'c2' },
			},
		});
	});

	it('marks the last page as complete', async () => {
		const { ctx } = contextReturning({ subjects: [acme], nextCursor: null });

		const result = await neowikiListSubjects.handle({}, ctx);

		expect(result.structuredContent).not.toHaveProperty('truncation');
	});

	it('passes continueFrom back as the cursor', async () => {
		const { mock, ctx } = contextReturning({ subjects: [], nextCursor: null });

		await neowikiListSubjects.handle({ continueFrom: 'c2' }, ctx);

		expect(requestedUrl(mock).searchParams.get('cursor')).toBe('c2');
	});
});
