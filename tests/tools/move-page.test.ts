import { describe, it, expect } from 'vitest';
import { movePage } from '../../src/tools/move-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { toolArgs } from '../helpers/toolArgs.ts';
import { contextWritingTo, writingWiki } from '../helpers/writingWiki.ts';

const MOVED = { move: { from: 'A', to: 'B' } };

function refusing(code: string): ReturnType<typeof writingWiki> {
	return writingWiki({ error: { code, info: `The move was refused (${code}).` } });
}

describe('move-page', () => {
	it('moves the page with its talk page, leaving a redirect, by default', async () => {
		const wiki = writingWiki({
			move: { from: 'Old Title', to: 'New Title', reason: 'tidy', redirectcreated: true },
		});

		const result = await movePage.handle(
			toolArgs(movePage, { fromTitle: 'Old Title', toTitle: 'New Title', comment: 'tidy' }),
			contextWritingTo(wiki),
		);

		expect(assertStructuredSuccess(result)).toBe(
			formatPayload({
				from: 'Old Title',
				to: 'New Title',
				redirectCreated: true,
				url: 'https://test.wiki/wiki/New_Title',
			}),
		);
		const sent = wiki.sentWrite();
		expect(sent.get('action')).toBe('move');
		expect(sent.get('from')).toBe('Old Title');
		expect(sent.get('to')).toBe('New Title');
		expect(sent.get('reason')).toContain('tidy');
		expect(sent.get('movetalk')).toBe('1');
		expect(sent.has('movesubpages')).toBe(false);
		expect(sent.has('noredirect')).toBe(false);
		expect(sent.has('ignorewarnings')).toBe(false);
	});

	it('asks for no redirect when leaveRedirect is false and reports none', async () => {
		const wiki = writingWiki({ move: { from: 'A', to: 'B', redirectcreated: false } });

		const result = await movePage.handle(
			toolArgs(movePage, { fromTitle: 'A', toTitle: 'B', leaveRedirect: false }),
			contextWritingTo(wiki),
		);

		expect(assertStructuredSuccess(result)).toContain('Redirect created: false');
		expect(wiki.sentWrite().get('noredirect')).toBe('1');
	});

	it('leaves the talk page behind when moveTalk is false', async () => {
		const wiki = writingWiki(MOVED);

		await movePage.handle(
			toolArgs(movePage, { fromTitle: 'A', toTitle: 'B', moveTalk: false }),
			contextWritingTo(wiki),
		);

		expect(wiki.sentWrite().get('action')).toBe('move');
		expect(wiki.sentWrite().has('movetalk')).toBe(false);
	});

	it('reports the talk page it moved', async () => {
		const wiki = writingWiki({
			move: { from: 'A', to: 'B', talkfrom: 'Talk:A', talkto: 'Talk:B' },
		});

		const result = await movePage.handle(
			toolArgs(movePage, { fromTitle: 'A', toTitle: 'B' }),
			contextWritingTo(wiki),
		);

		const text = assertStructuredSuccess(result);
		expect(text).toContain('Talk from: Talk:A');
		expect(text).toContain('Talk to: Talk:B');
	});

	it('moves subpages when asked and reports how many', async () => {
		const wiki = writingWiki({
			move: {
				from: 'A',
				to: 'B',
				subpages: [
					{ from: 'A/x', to: 'B/x' },
					{ from: 'A/y', to: 'B/y' },
				],
			},
		});

		const result = await movePage.handle(
			toolArgs(movePage, { fromTitle: 'A', toTitle: 'B', moveSubpages: true }),
			contextWritingTo(wiki),
		);

		expect(assertStructuredSuccess(result)).toContain('Subpages moved: 2');
		expect(wiki.sentWrite().get('movesubpages')).toBe('1');
	});

	it('reports a missing page as not_found', async () => {
		const result = await dispatch(
			movePage,
			contextWritingTo(refusing('missingtitle')),
		)(toolArgs(movePage, { fromTitle: 'Ghost', toTitle: 'B' }));

		assertStructuredError(result, 'not_found', 'missingtitle');
	});

	it('reports a taken target as conflict', async () => {
		const result = await dispatch(
			movePage,
			contextWritingTo(refusing('articleexists')),
		)(toolArgs(movePage, { fromTitle: 'A', toTitle: 'Taken' }));

		assertStructuredError(result, 'conflict', 'articleexists');
	});

	it('reports a move onto itself as invalid_input', async () => {
		const result = await dispatch(
			movePage,
			contextWritingTo(refusing('selfmove')),
		)(toolArgs(movePage, { fromTitle: 'A', toTitle: 'A' }));

		assertStructuredError(result, 'invalid_input', 'selfmove');
	});

	it('reports a refused move as permission_denied', async () => {
		const result = await dispatch(
			movePage,
			contextWritingTo(refusing('cantmove')),
		)(toolArgs(movePage, { fromTitle: 'A', toTitle: 'B' }));

		assertStructuredError(result, 'permission_denied', 'cantmove');
	});

	it("tags the move with the wiki's configured tags", async () => {
		const wiki = writingWiki(MOVED);

		await movePage.handle(
			toolArgs(movePage, { fromTitle: 'A', toTitle: 'B' }),
			contextWritingTo(wiki, 'mcp-edit'),
		);

		expect(wiki.sentWrite().get('tags')).toBe('mcp-edit');
	});
});
