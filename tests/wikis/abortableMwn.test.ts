import { describe, it, expect } from 'vitest';
import type { Mwn, RawRequestParams } from 'mwn';
import { withAbortSignal } from '../../src/wikis/abortableMwn.ts';
import { wrapMwnErrors } from '../../src/wikis/mwnErrorSanitizer.ts';

/**
 * A stand-in shaped like the parts of mwn this wrapper leans on: `rawRequest`
 * as the single network choke point, a `request` that reaches it through
 * `this`, and a mutable token field standing in for mwn's cached CSRF token.
 */
function createFakeBot(
	rawRequest: (options: RawRequestParams) => Promise<unknown>,
): Mwn & { csrfToken: string; calls: RawRequestParams[] } {
	const bot = {
		csrfToken: '%notoken%',
		calls: [] as RawRequestParams[],
		async rawRequest(options: RawRequestParams): Promise<unknown> {
			this.calls.push(options);
			return rawRequest(options);
		},
		async request(params: Record<string, unknown>): Promise<unknown> {
			// mwn reaches its own network method through `this`, which is what
			// makes intercepting `rawRequest` cover `request` and `query` too.
			return this.rawRequest({ url: 'https://wiki.example/api.php', data: params });
		},
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- test double covering only the surface under test
	return bot as unknown as Mwn & { csrfToken: string; calls: RawRequestParams[] };
}

describe('withAbortSignal', () => {
	it('attaches the signal to the request options', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withAbortSignal(bot, controller.signal).rawRequest({
			url: 'https://wiki.example/api.php',
		});

		expect(bot.calls[0]?.signal).toBe(controller.signal);
	});

	it('keeps the caller-supplied request options', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withAbortSignal(bot, controller.signal).rawRequest({
			url: 'https://wiki.example/api.php',
			method: 'post',
		});

		expect(bot.calls[0]?.url).toBe('https://wiki.example/api.php');
		expect(bot.calls[0]?.method).toBe('post');
	});

	it('reaches calls that mwn routes through its own `this.rawRequest`', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withAbortSignal(bot, controller.signal).request({ action: 'query' });

		// The Proxy returns methods unbound, so `this` inside `request` is the
		// Proxy and its internal hop is intercepted. Binding to the target here
		// would silently drop the signal from every internally-issued call.
		expect(bot.calls).toHaveLength(1);
		expect(bot.calls[0]?.signal).toBe(controller.signal);
	});

	it('marks an aborted failure so mwn does not retry it', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => {
			controller.abort();
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const err = await withAbortSignal(bot, controller.signal)
			.rawRequest({ url: 'https://wiki.example/api.php' })
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		// mwn's handleRequestFailure retries any rejection carrying no HTTP
		// response, and an aborted request has none — without this flag a
		// cancelled call sleeps through the full retry ladder before giving up.
		expect((err as { disableRetry?: boolean }).disableRetry).toBe(true);
	});

	it('leaves a genuine transient failure retriable', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => {
			throw Object.assign(new Error('socket hang up'), { code: 'ECONNRESET' });
		});

		const err = await withAbortSignal(bot, controller.signal)
			.rawRequest({ url: 'https://wiki.example/api.php' })
			.then(
				() => undefined,
				(e: unknown) => e,
			);

		expect((err as { disableRetry?: boolean }).disableRetry).toBeUndefined();
	});

	it('still reaches rawRequest when composed with the error sanitiser', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		// The composition production actually builds: the provider hands out an
		// error-sanitised instance, and the abort view goes on the outside. A
		// wrapper that rebinds `this` to the raw object breaks the outer proxy's
		// interception of mwn's internal hops, so the signal silently vanishes.
		await withAbortSignal(wrapMwnErrors(bot), controller.signal).request({ action: 'query' });

		expect(bot.calls[0]?.signal).toBe(controller.signal);
	});

	it('writes through to the shared instance so cached state is not shadowed', () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		const scoped = withAbortSignal(bot, controller.signal) as unknown as { csrfToken: string };
		scoped.csrfToken = 'fresh-token';

		// A per-request clone would strand this write on a throwaway object and
		// make every request re-fetch the token from the wiki.
		expect(bot.csrfToken).toBe('fresh-token');
	});
});
