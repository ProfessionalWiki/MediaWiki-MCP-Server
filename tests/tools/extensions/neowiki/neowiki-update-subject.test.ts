import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../../../helpers/mock-mwn.ts';
import { contextOn } from '../../../helpers/fakeContext.ts';
import { writeContextReturning, sentRequest } from '../../../helpers/rawRequest.ts';
import { neowikiUpdateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-update-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { httpError } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

const subject = { id: 's1demo', baseRevisionId: 1234 };

const stmts = { Founded: { propertyType: 'number', value: 2019 } };

const birth = {
	id: 's1demo6sssssss1',
	schema: 'Birth',
	statements: { Year: { propertyType: 'number', value: 1881 } },
};

const updated = { status: 'updated', subjectId: 's1demo' };

describe('neowiki-update-subject', () => {
	it('PUTs a full replace with a CSRF token', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		const result = await neowikiUpdateSubject.handle(
			{ ...subject, label: 'ACME', statements: stmts, comment: 'tidy' },
			ctx,
		);

		const request = sentRequest(mock);
		expect(request.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(request.method).toBe('PUT');
		expect(request.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(request.body).toMatchObject({ label: 'ACME', statements: stmts });
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'updated' });
	});

	it('sends the revision the change was made from', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiUpdateSubject.handle({ ...subject, statements: stmts }, ctx);

		expect(sentRequest(mock).body).toMatchObject({ baseRevisionId: 1234 });
	});

	it('returns the revision the page is at after the write', async () => {
		const { ctx } = writeContextReturning({ ...updated, revisionId: 1235 });

		const result = await neowikiUpdateSubject.handle({ ...subject, statements: stmts }, ctx);

		expect(result.structuredContent).toMatchObject({ revisionId: 1235 });
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiUpdateSubject.handle(
			{ ...subject, label: 'ACME', statements: stmts, comment: 'tidy' },
			ctx,
		);

		expect(sentRequest(mock).body).toMatchObject({
			comment: 'tidy (via neowiki-update-subject on MediaWiki MCP Server)',
		});
	});

	it('writes dependent subjects in the same request', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiUpdateSubject.handle(
			{ ...subject, statements: stmts, dependentSubjects: [birth] },
			ctx,
		);

		expect(sentRequest(mock).body).toMatchObject({ dependentSubjects: [birth] });
	});

	it('takes back the empty label a read returns for a subject without one', () => {
		expect(neowikiUpdateSubject.inputSchema.label.safeParse('').success).toBe(true);
	});

	it('omits the label when none is given, which clears it', async () => {
		const { mock, ctx } = writeContextReturning(updated);

		await neowikiUpdateSubject.handle({ ...subject, statements: stmts }, ctx);

		expect(sentRequest(mock).body).not.toHaveProperty('label');
	});

	it('returns the violations the write reported and the subject as saved', async () => {
		const violation = {
			propertyName: 'Founded',
			code: 'max-value',
			args: [2000],
			severity: 'warning',
		};
		const { ctx } = writeContextReturning({
			status: 'updated',
			subjectId: 's1demo',
			violations: [violation],
			subject: {
				id: 's1demo',
				label: 'ACME',
				displayName: 'ACME',
				schema: 'Company',
				statements: { Founded: { propertyType: 'number', value: 2019 } },
			},
		});
		const result = await neowikiUpdateSubject.handle(
			{ ...subject, label: 'ACME', statements: stmts },
			ctx,
		);

		expect(result.structuredContent).toMatchObject({
			violations: [violation],
			subject: { statements: { Founded: { propertyType: 'number', value: 2019 } } },
		});
	});

	it('maps a 404 to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(404, { status: 'error', message: 'gone' })),
		});
		const ctx = contextOn(mock);
		const result = await dispatch(
			neowikiUpdateSubject,
			ctx,
		)({ ...subject, id: 'sX', label: 'X', statements: {} });
		assertStructuredError(result, 'not_found');
	});
});
