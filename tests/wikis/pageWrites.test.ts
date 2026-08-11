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
	// Each case asserts a parameter that must be present alongside the one that
	// must be absent. Without it the absence assertion also passes for a body
	// that is not a query string at all, which is how the seam would go quiet.
	it('sends no reason parameter when delete is given none', async () => {
		const { writes, sent } = recordingWrites();

		await writes.delete('Some Page', undefined, {});

		expect(sent().get('action')).toBe('delete');
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

		expect(sent().get('action')).toBe('undelete');
		expect(sent().has('reason')).toBe(false);
	});

	// move is the one member whose argument order the interface could state
	// wrongly, so this pins where each title lands as well.
	it('sends no reason parameter when move is given none', async () => {
		const { writes, sent } = recordingWrites();

		await writes.move('Some Page', 'Other Page', undefined, {});

		expect(sent().get('from')).toBe('Some Page');
		expect(sent().get('to')).toBe('Other Page');
		expect(sent().has('reason')).toBe(false);
	});
});
