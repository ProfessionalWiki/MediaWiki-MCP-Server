import { describe, it, expect, vi } from 'vitest';
import { Mwn } from 'mwn';
import type { PageWrites } from '../../src/wikis/pageWrites.ts';

// PageWrites claims something about mwn that the compiler cannot check: that an
// undefined reason reaches the wire as no parameter at all. These drive a real
// Mwn with only its HTTP layer stubbed, so mwn's own parameter preprocessing
// still runs and a change to it fails here rather than silently on a wiki.
function recordingWrites(): { writes: PageWrites; sent: () => URLSearchParams } {
	const bot = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	let body = '';
	vi.spyOn(bot, 'rawRequest').mockImplementation((async (options: { data?: unknown }) => {
		body = String(options.data);
		return { data: { delete: {}, undelete: {}, move: {} } };
	}) as never);
	return { writes: bot, sent: () => new URLSearchParams(body) };
}

describe('PageWrites', () => {
	it('sends no reason parameter when delete is given none', async () => {
		const { writes, sent } = recordingWrites();

		await writes.delete('Some Page', undefined, {});

		expect(sent().has('reason')).toBe(false);
	});

	// The bug verbatim: an empty reason is a parameter MediaWiki records.
	it('sends an empty reason parameter when delete is given the empty string', async () => {
		const { writes, sent } = recordingWrites();

		await writes.delete('Some Page', '', {});

		expect(sent().get('reason')).toBe('');
	});

	it('sends no reason parameter when undelete is given none', async () => {
		const { writes, sent } = recordingWrites();

		await writes.undelete('Some Page', undefined, {});

		expect(sent().has('reason')).toBe(false);
	});

	it('sends no reason parameter when move is given none', async () => {
		const { writes, sent } = recordingWrites();

		await writes.move('Some Page', 'Other Page', undefined, {});

		expect(sent().has('reason')).toBe(false);
	});
});
