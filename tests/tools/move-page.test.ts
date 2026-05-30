import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { movePage } from '../../src/tools/move-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { formatPayload } from '../../src/results/format.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';

describe('move-page', () => {
	it('returns a structured payload and passes default options on success', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockResolvedValue({
				from: 'Old Title',
				to: 'New Title',
				reason: 'tidy',
				redirectcreated: '',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await movePage.handle(
			{ fromTitle: 'Old Title', toTitle: 'New Title', comment: 'tidy' },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({
				from: 'Old Title',
				to: 'New Title',
				redirectCreated: true,
				url: 'https://test.wiki/wiki/New_Title',
			}),
		);
		expect(mock.move).toHaveBeenCalledWith(
			'Old Title',
			'New Title',
			expect.stringContaining('tidy'),
			expect.objectContaining({
				movetalk: true,
				movesubpages: false,
				noredirect: false,
				ignorewarnings: false,
			}),
		);
	});

	it('sends noredirect when leaveRedirect is false and reports no redirect', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockResolvedValue({ from: 'A', to: 'B' }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await movePage.handle(
			{ fromTitle: 'A', toTitle: 'B', leaveRedirect: false },
			ctx,
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Redirect created: false');
		expect(mock.move).toHaveBeenCalledWith(
			'A',
			'B',
			expect.any(String),
			expect.objectContaining({ noredirect: true }),
		);
	});

	it('overrides mwn movetalk default and surfaces moved talk titles', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockResolvedValue({
				from: 'A',
				to: 'B',
				talkfrom: 'Talk:A',
				talkto: 'Talk:B',
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await movePage.handle({ fromTitle: 'A', toTitle: 'B', moveTalk: false }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Talk from: Talk:A');
		expect(text).toContain('Talk to: Talk:B');
		expect(mock.move).toHaveBeenCalledWith(
			'A',
			'B',
			expect.any(String),
			expect.objectContaining({ movetalk: false }),
		);
	});

	it('reports the number of subpages moved', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockResolvedValue({
				from: 'A',
				to: 'B',
				subpages: [
					{ from: 'A/x', to: 'B/x' },
					{ from: 'A/y', to: 'B/y' },
				],
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await movePage.handle({ fromTitle: 'A', toTitle: 'B', moveSubpages: true }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Subpages moved: 2');
		expect(mock.move).toHaveBeenCalledWith(
			'A',
			'B',
			expect.any(String),
			expect.objectContaining({ movesubpages: true }),
		);
	});

	it('dispatches missingtitle as not_found', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockRejectedValue(createMockMwnError('missingtitle')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(movePage, ctx)({ fromTitle: 'Ghost', toTitle: 'B' });

		assertStructuredError(result, 'not_found', 'missingtitle');
	});

	it('dispatches articleexists as conflict', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockRejectedValue(createMockMwnError('articleexists')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(movePage, ctx)({ fromTitle: 'A', toTitle: 'Taken' });

		assertStructuredError(result, 'conflict', 'articleexists');
	});

	it('dispatches selfmove as invalid_input', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockRejectedValue(createMockMwnError('selfmove')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(movePage, ctx)({ fromTitle: 'A', toTitle: 'A' });

		assertStructuredError(result, 'invalid_input', 'selfmove');
	});

	it('dispatches cantmove as permission_denied', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockRejectedValue(createMockMwnError('cantmove')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(movePage, ctx)({ fromTitle: 'A', toTitle: 'B' });

		assertStructuredError(result, 'permission_denied', 'cantmove');
	});

	it('injects tags from selection when configured', async () => {
		const mock = createMockMwn({
			move: vi.fn().mockResolvedValue({ from: 'A', to: 'B' }),
		});
		const ctx = fakeContext({
			mwn: async () => mock as never,
			edit: {
				submit: vi.fn() as never,
				submitUpload: vi.fn() as never,
				applyTags: (o: object) => ({ ...o, tags: 'mcp-edit' }),
			},
		});

		await movePage.handle({ fromTitle: 'A', toTitle: 'B' }, ctx);

		expect(mock.move).toHaveBeenCalledWith(
			'A',
			'B',
			expect.any(String),
			expect.objectContaining({ tags: 'mcp-edit' }),
		);
	});
});
