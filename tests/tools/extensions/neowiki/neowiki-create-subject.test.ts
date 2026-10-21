import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext, withoutEditAttribution } from '../../../helpers/fakeContext.ts';
import type { ToolContext } from '../../../../src/runtime/context.ts';
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

function contextWith(data: unknown): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockResolvedValue({ data }),
	});
	return { mock, ctx: fakeContext({ mwn: async () => mock as never }) };
}

function sentBody(mock: MockMwn): Record<string, unknown> {
	const { data } = mock.rawRequest.mock.calls[0][0] as { data: string };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON body the tool sent
	return JSON.parse(data) as Record<string, unknown>;
}

describe('neowiki-create-subject', () => {
	it('resolves a title and posts another subject of the page with a CSRF token', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ pageid: 7, title: 'Berlin' }] } }),
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'created', subjectId: 's1demo' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCreateSubject.handle(
			{ title: 'Berlin', label: 'Berlin', schema: 'City', statements: stmts },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/subjects');
		expect(call.method).toBe('POST');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(JSON.parse(call.data)).toMatchObject({
			label: 'Berlin',
			schema: 'City',
			statements: stmts,
		});
		expect(result.structuredContent).toMatchObject({
			subjectId: 's1demo',
			status: 'created',
			pageId: 7,
		});
	});

	it('posts to /mainSubject when isMain is true', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'created', subjectId: 's1' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiCreateSubject.handle(
			{ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		expect((mock.rawRequest.mock.calls[0][0] as { url: string }).url).toContain(
			'/page/7/mainSubject',
		);
	});

	it('reports a page that already has a main subject as a conflict', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockRejectedValue(httpError(409, { status: 'error', message: 'Subject already exists' })),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await dispatch(
			neowikiCreateSubject,
			ctx,
		)({ pageId: 7, isMain: true, label: 'X', schema: 'City', statements: stmts });
		assertStructuredError(result, 'conflict');
	});

	it('writes dependent subjects in the same request', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, schema: 'Person', statements: stmts, dependentSubjects: [birth] },
			ctx,
		);

		expect(sentBody(mock)).toMatchObject({ dependentSubjects: [birth] });
	});

	it('takes an empty label as no label', () => {
		expect(neowikiCreateSubject.inputSchema.label.safeParse('').success).toBe(true);
	});

	it('creates a subject without a label when none is given', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle({ pageId: 7, schema: 'City', statements: stmts }, ctx);

		expect(sentBody(mock)).not.toHaveProperty('label');
	});

	it('returns the violations the write reported and the subject as saved', async () => {
		const violation = {
			propertyName: 'Country',
			code: 'min-length',
			args: [3],
			severity: 'warning',
			valuePartIndex: 0,
		};
		const { ctx } = contextWith({
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
				statements: [{ property: 'Country', type: 'text', value: ['DE'] }],
			},
		});
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiCreateSubject.handle(
			{ label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		assertStructuredError(result, 'invalid_input');
	});

	it('returns not_found for an unknown title', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ missing: true, title: 'Nope' }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiCreateSubject.handle(
			{ title: 'Nope', label: 'X', schema: 'City', statements: stmts },
			ctx,
		);
		assertStructuredError(result, 'not_found');
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'X', schema: 'City', statements: stmts, comment: 'seed the city' },
			ctx,
		);

		expect(sentBody(mock)).toEqual({
			label: 'X',
			schema: 'City',
			statements: stmts,
			comment: 'seed the city (via neowiki-create-subject on MediaWiki MCP Server)',
		});
	});

	it('attributes a write the caller gave no comment for', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'X', schema: 'City', statements: stmts },
			ctx,
		);

		expect(sentBody(mock)).toMatchObject({
			comment: 'Automated edit (via neowiki-create-subject on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'X', schema: 'City', statements: stmts, comment: 'seed the city' },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).toMatchObject({ comment: 'seed the city' });
	});

	it('sends no comment at all when a wiki opts out and the caller gave none', async () => {
		const { mock, ctx } = contextWith(created);

		await neowikiCreateSubject.handle(
			{ pageId: 7, label: 'X', schema: 'City', statements: stmts },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).not.toHaveProperty('comment');
	});
});
