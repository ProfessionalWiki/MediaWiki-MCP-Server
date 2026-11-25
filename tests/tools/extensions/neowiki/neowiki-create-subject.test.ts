import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiCreateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-create-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { httpError } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const stmts = { Country: { propertyType: 'text', value: ['Germany'] } };

const birth = {
	id: 's1demo6sssssss1',
	schema: 'Birth',
	statements: { Year: { propertyType: 'number', value: 1881 } },
};

const created = { status: 'created', subjectId: 's1' };

describe('neowiki-create-subject', () => {
	it('resolves a title and posts another subject of the page with a CSRF token', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ pageid: 7, title: 'Berlin' }] } }),
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'created', subjectId: 's1demo' } }),
		});
		const result = await neowikiCreateSubject.handle(
			{ title: 'Berlin', label: 'Berlin', schema: 'City', statements: stmts },
			contextOn(mock),
		);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/subjects');
		expect(request.method).toBe('POST');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(request.body).toMatchObject({ label: 'Berlin', schema: 'City', statements: stmts });
		expect(result.structuredContent).toMatchObject({
			subjectId: 's1demo',
			status: 'created',
			pageId: 7,
		});
	});

	it('posts to /mainSubject when isMain is true', async () => {
		const { mock, ctx } = writeContextReturning(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts },
			ctx,
		);

		expect(sentRequest(mock).url).toContain('/page/7/mainSubject');
	});

	it('reports a page that already has a main subject as a conflict', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockRejectedValue(httpError(409, { status: 'error', message: 'Subject already exists' })),
		});
		const ctx = contextOn(mock);
		const result = await dispatch(
			neowikiCreateSubject,
			ctx,
		)({ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts });
		assertStructuredError(result, 'conflict');
	});

	it('writes dependent subjects in the same request', async () => {
		const { mock, ctx } = writeContextReturning(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, schema: 'Person', statements: stmts, dependentSubjects: [birth] },
			ctx,
		);

		expect(sentRequest(mock).body).toMatchObject({ dependentSubjects: [birth] });
	});

	it('returns the revision the page is at after the write', async () => {
		const { ctx } = writeContextReturning({ ...created, revisionId: 1235 });

		const result = await neowikiCreateSubject.handle(
			{ pageId: 7, schema: 'City', statements: stmts },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({ revisionId: 1235 });
	});

	it('takes an empty label as no label', () => {
		expect(neowikiCreateSubject.inputSchema.label.safeParse('').success).toBe(true);
	});

	it('creates a subject without a label when none is given', async () => {
		const { mock, ctx } = writeContextReturning(created);

		await neowikiCreateSubject.handle({ pageId: 7, schema: 'City', statements: stmts }, ctx);

		expect(sentRequest(mock).body).not.toHaveProperty('label');
	});

	it('returns the violations the write reported and the subject as saved', async () => {
		const violation = {
			propertyName: 'Country',
			code: 'min-length',
			args: [3],
			severity: 'warning',
			valuePartIndex: 0,
		};
		const { ctx } = writeContextReturning({
			status: 'created',
			subjectId: 's1demo',
			violations: [violation],
			subject: {
				id: 's1demo',
				label: 'Berlin',
				displayName: 'Berlin',
				schema: 'City',
				pageId: 7,
				pageTitle: 'Berlin',
				statements: { Country: { propertyType: 'text', value: ['DE'] } },
			},
		});
		const result = await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'Berlin', schema: 'City', statements: stmts },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({
			violations: [violation],
			subject: {
				displayName: 'Berlin',
				statements: { Country: { propertyType: 'text', value: ['DE'] } },
			},
		});
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = contextOn(createMockMwn());
		const result = await dispatch(
			neowikiCreateSubject,
			ctx,
		)({ label: 'X', schema: 'City', statements: stmts });
		assertStructuredError(result, 'invalid_input');
	});

	it('returns not_found for an unknown title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
		});
		const ctx = contextOn(mock);
		const result = await dispatch(
			neowikiCreateSubject,
			ctx,
		)({ title: 'Nope', label: 'X', schema: 'City', statements: stmts });
		assertStructuredError(result, 'not_found');
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = writeContextReturning(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'X', schema: 'City', statements: stmts, comment: 'seed the city' },
			ctx,
		);

		expect(sentRequest(mock).body).toEqual({
			label: 'X',
			schema: 'City',
			statements: stmts,
			comment: 'seed the city (via neowiki-create-subject on MediaWiki MCP Server)',
		});
	});
});
