import { describe, it, expect, vi, type Mock } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { fakeContext, withoutEditAttribution } from '../helpers/fakeContext.ts';
import { toolArgs } from '../helpers/toolArgs.ts';
import { protectPage } from '../../src/tools/protect-page.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { assertStructuredData, assertStructuredError } from '../helpers/structuredResult.ts';

// fakeContext's edit slice throws on any method a test leaves unstubbed.
const baseEdit = fakeContext().edit;

interface CurrentProtection {
	type: string;
	level: string;
	expiry: string;
	cascade?: true;
	source?: string;
}

const PROTECTED = { protect: { title: 'Main Page', reason: '', protections: [] } };

const WIKI_NOW = '2026-01-01T00:00:00Z';

// A wiki where Main Page carries the given protections and every other title
// none, so a read of the wrong title finds nothing to keep. Like the real one,
// it lists protections only for inprop=protection and reports its own clock,
// `now`, only for curtimestamp.
function wikiWith(
	current: CurrentProtection[],
	{ response = PROTECTED as unknown, now = WIKI_NOW } = {},
) {
	const mock = createMockMwn({
		request: vi.fn(
			async (params: { titles?: string; inprop?: string; curtimestamp?: boolean }) => ({
				...(params.curtimestamp === true ? { curtimestamp: now } : {}),
				query: {
					pages: [
						{
							title: params.titles,
							...(params.inprop?.includes('protection') === true
								? { protection: String(params.titles) === 'Main Page' ? current : [] }
								: {}),
						},
					],
				},
			}),
		),
	});
	const submit = vi.fn().mockResolvedValue(response);
	const ctx = fakeContext({ mwn: async () => mock as never, edit: { ...baseEdit, submit } });
	return { ctx, submit };
}

function protectRequest(submit: Mock): Record<string, unknown> {
	return submit.mock.calls[0][1];
}

function asList(value: unknown): string[] {
	return Array.isArray(value) ? value : String(value).split('|');
}

// What the wiki is asked to apply, read the way action=protect reads it: the
// nth expiry belongs to the nth protection, and a single expiry covers them all.
function requestedProtections(submit: Mock): Record<string, { level: string; expiry: string }> {
	const params = protectRequest(submit);
	const expiries = asList(params.expiry ?? 'infinite');
	return Object.fromEntries(
		asList(params.protections).map((protection, i) => {
			const [action, level] = protection.split('=');
			return [action, { level, expiry: expiries.length === 1 ? expiries[0] : expiries[i] }];
		}),
	);
}

// mwn sends true as a set flag and drops false.
function asksToCascade(submit: Mock): boolean {
	return Boolean(protectRequest(submit).cascade);
}

describe('protect-page', () => {
	it('applies each named action at its level until the given expiry', async () => {
		const { ctx, submit } = wikiWith([]);

		await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'autoconfirmed', move: 'sysop' },
				expiry: '1 week',
			}),
			ctx,
		);

		expect(protectRequest(submit)).toMatchObject({ action: 'protect', title: 'Main Page' });
		expect(requestedProtections(submit)).toEqual({
			edit: { level: 'autoconfirmed', expiry: '1 week' },
			move: { level: 'sysop', expiry: '1 week' },
		});
	});

	it('keeps the current protection of an action the call leaves out, with its own expiry', async () => {
		const { ctx, submit } = wikiWith([
			{ type: 'edit', level: 'sysop', expiry: 'infinity' },
			{ type: 'move', level: 'sysop', expiry: 'infinity' },
		]);

		await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'autoconfirmed' },
				expiry: '1 week',
			}),
			ctx,
		);

		expect(requestedProtections(submit)).toEqual({
			edit: { level: 'autoconfirmed', expiry: '1 week' },
			move: { level: 'sysop', expiry: 'infinity' },
		});
	});

	// The expiry is already behind the host's clock, so only the wiki's clock can
	// tell that it has not passed.
	it("keeps a protection that is still in force by the wiki's clock", async () => {
		const { ctx, submit } = wikiWith(
			[{ type: 'move', level: 'sysop', expiry: '2020-06-01T00:00:00Z' }],
			{ now: '2020-01-01T00:00:00Z' },
		);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'sysop' } }),
			ctx,
		);

		expect(requestedProtections(submit)).toEqual({
			edit: { level: 'sysop', expiry: 'infinite' },
			move: { level: 'sysop', expiry: '2020-06-01T00:00:00Z' },
		});
	});

	// The expiry is still ahead by the host's clock, so only the wiki's clock
	// can tell that it has passed.
	it("does not reinstate a protection that has expired by the wiki's clock", async () => {
		const { ctx, submit } = wikiWith(
			[{ type: 'move', level: 'sysop', expiry: '2089-12-31T00:00:00Z' }],
			{ now: '2090-01-01T00:00:00Z' },
		);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'sysop' } }),
			ctx,
		);

		expect(requestedProtections(submit)).toEqual({
			edit: { level: 'sysop', expiry: 'infinite' },
		});
	});

	it('does not copy a protection the page inherits from a cascading page', async () => {
		const { ctx, submit } = wikiWith([
			{ type: 'move', level: 'sysop', expiry: 'infinity', source: 'Other Page' },
		]);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'sysop' } }),
			ctx,
		);

		expect(requestedProtections(submit)).toEqual({
			edit: { level: 'sysop', expiry: 'infinite' },
		});
	});

	// Naming edit replaces the protection that carries the cascade flag, so the
	// current setting has to come from before the change.
	it('keeps cascading on when the call leaves cascade out', async () => {
		const { ctx, submit } = wikiWith([
			{ type: 'edit', level: 'sysop', expiry: 'infinity', cascade: true },
		]);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'sysop' } }),
			ctx,
		);

		expect(asksToCascade(submit)).toBe(true);
	});

	it('leaves cascading off when the call leaves cascade out', async () => {
		const { ctx, submit } = wikiWith([{ type: 'edit', level: 'sysop', expiry: 'infinity' }]);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { move: 'sysop' } }),
			ctx,
		);

		expect(asksToCascade(submit)).toBe(false);
	});

	it('turns cascading off when the call sets cascade to false', async () => {
		const { ctx, submit } = wikiWith([
			{ type: 'edit', level: 'sysop', expiry: 'infinity', cascade: true },
		]);

		await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'sysop' },
				cascade: false,
			}),
			ctx,
		);

		expect(asksToCascade(submit)).toBe(false);
	});

	it('turns cascading on when the call sets cascade to true', async () => {
		const { ctx, submit } = wikiWith([]);

		await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'sysop' },
				cascade: true,
			}),
			ctx,
		);

		expect(asksToCascade(submit)).toBe(true);
	});

	it("reports the page's protections after the change, leaving out lifted ones", async () => {
		const { ctx } = wikiWith([], {
			response: {
				protect: {
					title: 'Main Page',
					reason: '',
					cascade: true,
					protections: [
						{ edit: 'sysop', expiry: '2099-01-01T00:00:00Z' },
						{ move: '', expiry: 'infinite' },
					],
				},
			},
		});

		const result = await protectPage.handle(
			toolArgs(protectPage, { title: 'main page', protections: { edit: 'sysop', move: 'all' } }),
			ctx,
		);

		expect(assertStructuredData(result)).toEqual({
			title: 'Main Page',
			protections: [{ action: 'edit', level: 'sysop', expiry: '2099-01-01T00:00:00Z' }],
			cascade: true,
		});
	});

	// The wiki drops cascading unless edit protection is at a cascading level,
	// and says so only by leaving the flag out of its response.
	it('reports cascading as off when the wiki declines to cascade', async () => {
		const { ctx } = wikiWith([], {
			response: {
				protect: {
					title: 'Main Page',
					reason: '',
					protections: [{ edit: 'autoconfirmed', expiry: 'infinite' }],
				},
			},
		});

		const result = await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'autoconfirmed' },
				cascade: true,
			}),
			ctx,
		);

		expect(assertStructuredData(result).cascade).toBe(false);
	});

	it('sends the comment as the reason, attributed to protect-page', async () => {
		const { ctx, submit } = wikiWith([]);

		await protectPage.handle(
			toolArgs(protectPage, {
				title: 'Main Page',
				protections: { edit: 'sysop' },
				comment: 'Persistent vandalism',
			}),
			ctx,
		);

		expect(protectRequest(submit).reason).toContain('Persistent vandalism');
		expect(protectRequest(submit).reason).toContain('protect-page');
	});

	// action=protect's reason defaults to the empty string, so the wiki records
	// an absent reason and an empty one alike.
	it('records no reason when a wiki opts out of attribution and the call gives no comment', async () => {
		const { ctx, submit } = wikiWith([]);

		await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'sysop' } }),
			withoutEditAttribution(ctx),
		);

		expect(protectRequest(submit)).toMatchObject({ action: 'protect' });
		expect(protectRequest(submit).reason ?? '').toBe('');
	});

	it('rejects a call that names no action, without changing the wiki', async () => {
		const { ctx, submit } = wikiWith([]);

		const result = await protectPage.handle(
			toolArgs(protectPage, { title: 'Main Page', protections: {} }),
			ctx,
		);

		assertStructuredError(result, 'invalid_input');
		expect(submit).not.toHaveBeenCalled();
	});

	it('reports a level the wiki does not have as invalid input to protect the page', async () => {
		const { ctx, submit } = wikiWith([]);
		submit.mockRejectedValue(createMockMwnError('protect-invalidlevel'));

		const result = await dispatch(
			protectPage,
			ctx,
		)(toolArgs(protectPage, { title: 'Main Page', protections: { edit: 'staff' } }));

		const envelope = assertStructuredError(result, 'invalid_input', 'protect-invalidlevel');
		expect(envelope.message).toContain('protect page');
	});
});
