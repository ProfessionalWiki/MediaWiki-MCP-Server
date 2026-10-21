import { describe, it, expect } from 'vitest';
import { undeletePage } from '../../src/tools/undelete-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';
import { contextWritingTo, writingWiki } from '../helpers/writingWiki.ts';

const RESTORED = { undelete: { title: 'Restored Page', reason: 'oops', revisions: 12 } };

describe('undelete-page', () => {
	it('restores the page and reports how many revisions came back', async () => {
		const wiki = writingWiki(RESTORED);

		const result = await undeletePage.handle(
			{ title: 'Restored Page', comment: 'oops' },
			contextWritingTo(wiki),
		);

		expect(assertStructuredSuccess(result)).toBe(
			formatPayload({ title: 'Restored Page', restored: true, revisionCount: 12 }),
		);
		expect(wiki.sentWrite().get('action')).toBe('undelete');
		expect(wiki.sentWrite().get('title')).toBe('Restored Page');
		expect(wiki.sentWrite().get('reason')).toContain('oops');
	});

	it('works without a revision count', async () => {
		const wiki = writingWiki({ undelete: { title: 'Restored Page' } });

		const result = await undeletePage.handle({ title: 'Restored Page' }, contextWritingTo(wiki));

		expect(assertStructuredSuccess(result)).not.toContain('Revision count:');
	});

	it('reports a refused restore as permission_denied', async () => {
		const wiki = writingWiki({
			error: { code: 'permissiondenied', info: 'You do not have permission to undelete pages.' },
		});

		const result = await dispatch(undeletePage, contextWritingTo(wiki))({ title: 'Protected' });

		assertStructuredError(result, 'permission_denied', 'permissiondenied');
	});

	it('reports an unrecognised failure with the standard verb prefix', async () => {
		const wiki = writingWiki({ error: { code: 'somethingbroke', info: 'Database down' } });

		const result = await dispatch(undeletePage, contextWritingTo(wiki))({ title: 'Some Page' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/^Failed to undelete page: .*Database down/);
	});

	it("tags the restore with the wiki's configured tags", async () => {
		const wiki = writingWiki(RESTORED);

		await undeletePage.handle({ title: 'X' }, contextWritingTo(wiki, 'mcp-edit'));

		expect(wiki.sentWrite().get('tags')).toBe('mcp-edit');
	});
});
