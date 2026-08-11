import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext, withoutEditAttribution } from '../../../helpers/fakeContext.ts';
import type { ToolContext } from '../../../../src/runtime/context.ts';
import { neowikiUpdateSubject } from '../../../../src/tools/extensions/neowiki/neowiki-update-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

const stmts = { Founded: { propertyType: 'number', value: 2019 } };

function contextWith(): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockResolvedValue({ data: { status: 'updated', subjectId: 's1demo' } }),
	});
	return { mock, ctx: fakeContext({ mwn: async () => mock as never }) };
}

function sentBody(mock: MockMwn): Record<string, unknown> {
	const { data } = mock.rawRequest.mock.calls[0][0] as { data: string };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON body the tool sent
	return JSON.parse(data) as Record<string, unknown>;
}

describe('neowiki-update-subject', () => {
	it('PUTs a full replace with a CSRF token', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'updated', subjectId: 's1demo' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiUpdateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts, comment: 'tidy' },
			ctx,
		);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(call.method).toBe('PUT');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(JSON.parse(call.data)).toMatchObject({ label: 'ACME', statements: stmts });
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'updated' });
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = contextWith();

		await neowikiUpdateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts, comment: 'tidy' },
			ctx,
		);

		expect(sentBody(mock)).toEqual({
			label: 'ACME',
			statements: stmts,
			comment: 'tidy (via neowiki-update-subject on MediaWiki MCP Server)',
		});
	});

	it('attributes a write the caller gave no comment for', async () => {
		const { mock, ctx } = contextWith();

		await neowikiUpdateSubject.handle({ id: 's1demo', label: 'ACME', statements: stmts }, ctx);

		expect(sentBody(mock)).toMatchObject({
			comment: 'Automated edit (via neowiki-update-subject on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { mock, ctx } = contextWith();

		await neowikiUpdateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts, comment: 'tidy' },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).toMatchObject({ comment: 'tidy' });
	});

	it('sends no comment at all when a wiki opts out and the caller gave none', async () => {
		const { mock, ctx } = contextWith();

		await neowikiUpdateSubject.handle(
			{ id: 's1demo', label: 'ACME', statements: stmts },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).not.toHaveProperty('comment');
	});

	it('maps a 404 to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(404, { status: 'error', message: 'gone' })),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiUpdateSubject.handle({ id: 'sX', label: 'X', statements: {} }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
