import { describe, it, expect } from 'vitest';
import { withoutEditAttribution } from '../helpers/fakeContext.ts';
import { deletePage } from '../../src/tools/delete-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { contextWritingTo, writingWiki } from '../helpers/writingWiki.ts';

const DELETED = { delete: { title: 'Old Page', reason: 'spam', logid: 42 } };

describe('delete-page', () => {
	it('deletes the page and reports the log entry', async () => {
		const wiki = writingWiki(DELETED);

		const result = await deletePage.handle(
			{ title: 'Old Page', comment: 'spam' },
			contextWritingTo(wiki),
		);

		expect(assertStructuredSuccess(result)).toBe(
			formatPayload({ title: 'Old Page', deleted: true, logId: 42 }),
		);
		expect(wiki.sentWrite().get('action')).toBe('delete');
		expect(wiki.sentWrite().get('title')).toBe('Old Page');
		expect(wiki.sentWrite().get('reason')).toContain('spam');
	});

	it('works without a logid in the response', async () => {
		const wiki = writingWiki({ delete: { title: 'Old Page' } });

		const result = await deletePage.handle({ title: 'Old Page' }, contextWritingTo(wiki));

		expect(assertStructuredSuccess(result)).not.toContain('Log ID:');
	});

	it('reports a missing page as not_found', async () => {
		const wiki = writingWiki({
			error: { code: 'missingtitle', info: "The page you specified doesn't exist." },
		});

		const result = await dispatch(deletePage, contextWritingTo(wiki))({ title: 'Nonexistent' });

		assertStructuredError(result, 'not_found', 'missingtitle');
	});

	it('reports a refused deletion as permission_denied', async () => {
		const wiki = writingWiki({
			error: { code: 'permissiondenied', info: 'You do not have permission to delete pages.' },
		});

		const result = await dispatch(deletePage, contextWritingTo(wiki))({ title: 'Protected' });

		assertStructuredError(result, 'permission_denied', 'permissiondenied');
	});

	// An empty reason is not an absent one: ApiDelete autogenerates its
	// "content was: …" reason only when the parameter arrives as null, so
	// sending it empty leaves the deletion log entry blank.
	it('sends no reason at all when a wiki opts out and the caller gave no comment', async () => {
		const wiki = writingWiki(DELETED);

		await deletePage.handle({ title: 'X' }, withoutEditAttribution(contextWritingTo(wiki)));

		expect(wiki.sentWrite().get('action')).toBe('delete');
		expect(wiki.sentWrite().has('reason')).toBe(false);
	});

	it('sends the caller comment as the reason when a wiki opts out', async () => {
		const wiki = writingWiki(DELETED);

		await deletePage.handle(
			{ title: 'X', comment: 'spam' },
			withoutEditAttribution(contextWritingTo(wiki)),
		);

		expect(wiki.sentWrite().get('reason')).toBe('spam');
	});

	it("tags the deletion with the wiki's configured tags", async () => {
		const wiki = writingWiki(DELETED);

		await deletePage.handle({ title: 'X' }, contextWritingTo(wiki, 'mcp-edit'));

		expect(wiki.sentWrite().get('tags')).toBe('mcp-edit');
	});
});
