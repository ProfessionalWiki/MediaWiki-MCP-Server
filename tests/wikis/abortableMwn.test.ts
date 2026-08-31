import { describe, it, expect } from 'vitest';
import type { Mwn, RawRequestParams } from 'mwn';
import { withCallBounds } from '../../src/wikis/abortableMwn.ts';
import { callDeadline } from '../../src/runtime/callDeadline.ts';
import { WikiTimeoutError } from '../../src/errors/wikiTimeoutError.ts';
import { wrapMwnErrors } from '../../src/wikis/mwnErrorSanitizer.ts';
import { rejectionOf } from '../helpers/rejectionOf.ts';

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

describe('withCallBounds', () => {
	it('tears a request down when the caller cancels', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).rawRequest({
			url: 'https://wiki.example/api.php',
		});

		// Behavioural, not by identity: the attached signal is composed from both.
		const attached = bot.calls[0]?.signal;
		expect(attached?.aborted).toBe(false);
		controller.abort();
		expect(attached?.aborted).toBe(true);
	});

	it('tears a request down when the call runs out of budget', async () => {
		const bot = createFakeBot(async () => ({ ok: true }));

		await withCallBounds(bot, callDeadline(5, 'calling'), new AbortController().signal).rawRequest({
			url: 'https://wiki.example/api.php',
		});

		const attached = bot.calls[0]?.signal;
		expect(attached?.aborted).toBe(false);
		// `AbortSignal.timeout` is unref'd and is not advanced by vitest's fake
		// timers, so a deadline test has to wait on the real clock.
		await new Promise((resolve) => setTimeout(resolve, 20));
		expect(attached?.aborted).toBe(true);
	});

	it('bounds the call even when the caller supplies no cancellation', async () => {
		const bot = createFakeBot(async () => ({ ok: true }));
		const deadline = callDeadline(60_000, 'calling');

		await withCallBounds(bot, deadline).rawRequest({ url: 'https://wiki.example/api.php' });

		// With nothing to compose, the deadline's own signal travels unwrapped.
		expect(bot.calls[0]?.signal).toBe(deadline.signal);
	});

	it('keeps the caller-supplied request options', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).rawRequest({
			url: 'https://wiki.example/api.php',
			method: 'post',
		});

		expect(bot.calls[0]?.url).toBe('https://wiki.example/api.php');
		expect(bot.calls[0]?.method).toBe('post');
	});

	it('reaches calls that mwn routes through its own `this.rawRequest`', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		await withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).request({
			action: 'query',
		});

		// The Proxy returns methods unbound, so `this` inside `request` is the
		// Proxy and its internal hop is intercepted. Binding to the target here
		// would silently drop the signal from every internally-issued call.
		expect(bot.calls).toHaveLength(1);
		expect(bot.calls[0]?.signal?.aborted).toBe(false);
		controller.abort();
		expect(bot.calls[0]?.signal?.aborted).toBe(true);
	});

	it('marks an aborted failure so mwn does not retry it', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => {
			controller.abort();
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const err = await rejectionOf(
			withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
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

		const err = await rejectionOf(
			withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
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
		await withCallBounds(
			wrapMwnErrors(bot),
			callDeadline(60_000, 'calling'),
			controller.signal,
		).request({
			action: 'query',
		});

		expect(bot.calls[0]?.signal?.aborted).toBe(false);
		controller.abort();
		expect(bot.calls[0]?.signal?.aborted).toBe(true);
	});

	it('writes through to the shared instance so cached state is not shadowed', () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => ({ ok: true }));

		const scoped = withCallBounds(
			bot,
			callDeadline(60_000, 'calling'),
			controller.signal,
		) as unknown as {
			csrfToken: string;
		};
		scoped.csrfToken = 'fresh-token';

		// A per-request clone would strand this write on a throwaway object and
		// make every request re-fetch the token from the wiki.
		expect(bot.csrfToken).toBe('fresh-token');
	});
	it('reports an expired deadline as a timeout naming the budget', async () => {
		const bot = createFakeBot(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		// Armed in 5ms so the test does not wait, but reporting the production
		// budget, so the assertion is made on the subject rather than on an error
		// the test built itself.
		const err = await rejectionOf(
			withCallBounds(bot, {
				signal: AbortSignal.timeout(5),
				timeoutMs: 150_000,
				phase: 'calling',
			}).rawRequest({ url: 'https://wiki.example/api.php' }),
		);

		// Without the replacement the caller reads "canceled": axios reports an
		// abort with a `code`, and classifyError skips its message fallbacks
		// whenever a code is present, so nothing downstream can improve it.
		expect(err).toBeInstanceOf(WikiTimeoutError);
		expect((err as { disableRetry?: boolean }).disableRetry).toBe(true);
		// The budget is named so a caller can tell how long it actually waited.
		expect((err as Error).message).toContain('150 seconds');
	});

	it('reports a cancellation as a cancellation, not as a timeout', async () => {
		const controller = new AbortController();
		const bot = createFakeBot(async () => {
			controller.abort();
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const err = await rejectionOf(
			withCallBounds(bot, callDeadline(60_000, 'calling'), controller.signal).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
		);

		// The dispatcher tells the two apart to decide whether a failed call was
		// the caller walking away or the wiki running out of time; replacing a
		// cancellation with a timeout would report every cancelled call as an
		// upstream fault.
		expect(err).not.toBeInstanceOf(WikiTimeoutError);
		expect((err as { disableRetry?: boolean }).disableRetry).toBe(true);
	});
	it('reports an expired deadline as a timeout with a live cancellation composed in', async () => {
		// The shape production always has: the SDK supplies a cancellation signal
		// on every request, so the deadline never travels alone. Without this the
		// reason-identity check that tells the two apart is never exercised, and
		// deleting it would go unnoticed.
		const bot = createFakeBot(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const err = await rejectionOf(
			withCallBounds(bot, callDeadline(5, 'calling'), new AbortController().signal).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
		);

		expect(err).toBeInstanceOf(WikiTimeoutError);
	});

	it('surfaces a batch that ran out of budget instead of returning it as data', async () => {
		const bot = createFakeBot(async () => ({ ok: true }));
		// mwn resolves massQuery with per-batch errors placed in the array rather
		// than rejecting it.
		Object.assign(bot, {
			async massQuery(): Promise<unknown[]> {
				return [{ query: { pages: [] } }, new WikiTimeoutError(150_000, 'calling')];
			},
		});

		const expired = callDeadline(5, 'calling');
		await new Promise((resolve) => setTimeout(resolve, 20));
		const err = await rejectionOf(
			withCallBounds(bot, expired).massQuery({ action: 'query', titles: ['A'] }, 'titles'),
		);

		// Left as data, this reaches get-pages as a batch with no `query` and is
		// skipped — reporting a timeout as every requested page being missing.
		expect(err).toBeInstanceOf(WikiTimeoutError);
	});

	it('leaves an ordinary per-batch failure in place', async () => {
		const bot = createFakeBot(async () => ({ ok: true }));
		const batchFailure = Object.assign(new Error('server error'), { code: 'internal_api_error' });
		Object.assign(bot, {
			async massQuery(): Promise<unknown[]> {
				return [{ query: { pages: [] } }, batchFailure];
			},
		});

		const responses = await withCallBounds(bot, callDeadline(60_000, 'calling')).massQuery(
			{ action: 'query', titles: ['A'] },
			'titles',
		);

		// mwn collects these deliberately so one bad batch does not lose the rest.
		expect(responses[1]).toBe(batchFailure);
	});
	it('keeps reporting a cancellation as one even after the budget also expires', async () => {
		const controller = new AbortController();
		// Aborted before the request is issued, so which signal fired first is
		// fixed rather than raced. The request then outlives the budget, so by the
		// time the failure surfaces BOTH have fired and only the order tells them
		// apart.
		controller.abort();
		const bot = createFakeBot(async () => {
			await new Promise((resolve) => setTimeout(resolve, 60));
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const deadline = callDeadline(20, 'calling');
		const err = await rejectionOf(
			withCallBounds(bot, deadline, controller.signal).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
		);

		// Asserted, not assumed: both assertions below also hold if the deadline
		// never fires, so lengthening it would disarm the test silently.
		expect(deadline.signal.aborted).toBe(true);
		expect(err).not.toBeInstanceOf(WikiTimeoutError);
		expect((err as { disableRetry?: boolean }).disableRetry).toBe(true);
	});
	it('keeps the bound on the requests massQuery issues internally', async () => {
		const bot = createFakeBot(async () => ({ query: { pages: [] } }));
		// mwn's massQuery reaches the network through `this.request`, so the double
		// must too: a stub that ignores `this` cannot observe the receiver, and
		// rebinding it cuts this Proxy out of the hop.
		Object.assign(bot, {
			async massQuery(this: Mwn, query: unknown): Promise<unknown[]> {
				return [await this.request(query as never)];
			},
		});

		await withCallBounds(bot, callDeadline(60_000, 'calling')).massQuery(
			{ action: 'query', titles: ['A'] },
			'titles',
		);

		expect(bot.calls[0]?.signal).toBeDefined();
	});
	it('reports the phase of the budget that expired', async () => {
		const bot = createFakeBot(async () => {
			await new Promise((resolve) => setTimeout(resolve, 50));
			throw Object.assign(new Error('canceled'), { code: 'ERR_CANCELED' });
		});

		const err = await rejectionOf(
			withCallBounds(bot, callDeadline(5, 'connecting')).rawRequest({
				url: 'https://wiki.example/api.php',
			}),
		);

		expect((err as WikiTimeoutError).phase).toBe('connecting');
		expect((err as Error).message).toContain('Gave up trying to reach the wiki');
	});
});
