import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { fakeContext, withoutEditAttribution } from '../../../helpers/fakeContext.ts';
import type { ToolContext } from '../../../../src/runtime/context.ts';
import { neowikiSetMainSubject } from '../../../../src/tools/extensions/neowiki/neowiki-set-main-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';

function httpError(status: number, data: unknown): Error & { response: unknown } {
	const err = new Error(`HTTP ${status}`) as Error & { response: unknown };
	err.response = { status, data };
	return err;
}

function contextWith(): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockResolvedValue({ data: { status: 'changed' } }),
	});
	return { mock, ctx: fakeContext({ mwn: async () => mock as never }) };
}

function sentBody(mock: MockMwn): Record<string, unknown> {
	const { data } = mock.rawRequest.mock.calls[0][0] as { data: string };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON body the tool sent
	return JSON.parse(data) as Record<string, unknown>;
}

describe('neowiki-set-main-subject', () => {
	it('promotes a subject and returns changed', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'changed' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 's1demo' }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as { url: string; method: string; data: string };
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/page/7/mainSubject');
		expect(call.method).toBe('PUT');
		expect(JSON.parse(call.data)).toMatchObject({ subjectId: 's1demo' });
		expect(result.structuredContent).toMatchObject({ pageId: 7, status: 'changed' });
	});

	it('sends subjectId:null to clear the main subject', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockResolvedValue({ data: { status: 'changed' } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		await neowikiSetMainSubject.handle({ pageId: 7, subjectId: null }, ctx);
		expect(JSON.parse((mock.rawRequest.mock.calls[0][0] as { data: string }).data)).toMatchObject({
			subjectId: null,
		});
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = contextWith();

		await neowikiSetMainSubject.handle(
			{ pageId: 7, subjectId: 's1demo', comment: 'promote Berlin' },
			ctx,
		);

		expect(sentBody(mock)).toEqual({
			subjectId: 's1demo',
			comment: 'promote Berlin (via neowiki-set-main-subject on MediaWiki MCP Server)',
		});
	});

	it('attributes a write the caller gave no comment for', async () => {
		const { mock, ctx } = contextWith();

		await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 's1demo' }, ctx);

		expect(sentBody(mock)).toMatchObject({
			comment: 'Automated edit (via neowiki-set-main-subject on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { mock, ctx } = contextWith();

		await neowikiSetMainSubject.handle(
			{ pageId: 7, subjectId: 's1demo', comment: 'promote Berlin' },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).toMatchObject({ comment: 'promote Berlin' });
	});

	it('sends no comment at all when a wiki opts out and the caller gave none', async () => {
		const { mock, ctx } = contextWith();

		await neowikiSetMainSubject.handle(
			{ pageId: 7, subjectId: 's1demo' },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).not.toHaveProperty('comment');
	});

	it('rejects when neither title nor pageId is given', async () => {
		const ctx = fakeContext({ mwn: async () => createMockMwn() as never });
		const result = await neowikiSetMainSubject.handle({ subjectId: 's1' }, ctx);
		assertStructuredError(result, 'invalid_input');
	});

	it('maps a 404 (subject not on page) to not_found', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi
				.fn()
				.mockRejectedValue(
					httpError(404, { status: 'error', message: 'Subject not found on this page' }),
				),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });
		const result = await neowikiSetMainSubject.handle({ pageId: 7, subjectId: 'sX' }, ctx);
		assertStructuredError(result, 'not_found');
	});
});
