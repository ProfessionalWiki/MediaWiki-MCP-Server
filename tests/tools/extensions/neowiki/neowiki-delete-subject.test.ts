import { describe, it, expect, vi } from 'vitest';
import { createMockMwn, type MockMwn } from '../../../helpers/mock-mwn.ts';
import { withoutEditAttribution, contextOn } from '../../../helpers/fakeContext.ts';
import type { ToolContext } from '../../../../src/runtime/context.ts';
import { neowikiDeleteSubject } from '../../../../src/tools/extensions/neowiki/neowiki-delete-subject.ts';
import { assertStructuredError } from '../../../helpers/structuredResult.ts';
import { httpError } from '../../../helpers/httpError.ts';
import { dispatch } from '../../../../src/runtime/dispatcher.ts';

function contextWith(): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockResolvedValue({ data: '' }),
	});
	return { mock, ctx: contextOn(mock) };
}

function sentBody(mock: MockMwn): Record<string, unknown> | undefined {
	const { data } = mock.rawRequest.mock.calls[0][0] as { data?: string };
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON body the tool sent
	return data === undefined ? undefined : (JSON.parse(data) as Record<string, unknown>);
}

describe('neowiki-delete-subject', () => {
	it('DELETEs with a CSRF token and reports deleted', async () => {
		const { mock, ctx } = contextWith();
		const result = await neowikiDeleteSubject.handle({ id: 's1demo', comment: 'spam' }, ctx);
		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject/s1demo');
		expect(call.method).toBe('DELETE');
		expect(call.headers['X-CSRF-TOKEN']).toBe('tok');
		expect(result.structuredContent).toMatchObject({ subjectId: 's1demo', status: 'deleted' });
	});

	it('attributes the write to the tool that made it, after the caller comment', async () => {
		const { mock, ctx } = contextWith();

		await neowikiDeleteSubject.handle({ id: 's1demo', comment: 'spam' }, ctx);

		expect(sentBody(mock)).toEqual({
			comment: 'spam (via neowiki-delete-subject on MediaWiki MCP Server)',
		});
	});

	it('attributes a write the caller gave no comment for', async () => {
		const { mock, ctx } = contextWith();

		await neowikiDeleteSubject.handle({ id: 's1demo' }, ctx);

		expect(sentBody(mock)).toEqual({
			comment: 'Automated edit (via neowiki-delete-subject on MediaWiki MCP Server)',
		});
	});

	it('drops the attribution for a wiki that opts out of it', async () => {
		const { mock, ctx } = contextWith();

		await neowikiDeleteSubject.handle(
			{ id: 's1demo', comment: 'spam' },
			withoutEditAttribution(ctx),
		);

		expect(sentBody(mock)).toEqual({ comment: 'spam' });
	});

	it('omits the body when a wiki opts out and the caller gave no comment', async () => {
		const { mock, ctx } = contextWith();

		await neowikiDeleteSubject.handle({ id: 's1demo' }, withoutEditAttribution(ctx));

		expect(sentBody(mock)).toBeUndefined();
	});

	it('reports a 403 as a permission_denied failure of the delete', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('tok'),
			rawRequest: vi.fn().mockRejectedValue(httpError(403, { status: 'error', message: 'nope' })),
		});
		const ctx = contextOn(mock);

		const result = await dispatch(neowikiDeleteSubject, ctx)({ id: 's1demo' });

		expect(assertStructuredError(result, 'permission_denied').message).toBe(
			'Failed to delete NeoWiki subject: nope',
		);
	});
});
