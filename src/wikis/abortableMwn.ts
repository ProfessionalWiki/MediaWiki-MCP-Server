import type { Mwn, RawRequestParams } from 'mwn';
import type { CallDeadline } from '../runtime/callDeadline.ts';
import { WikiTimeoutError } from '../errors/wikiTimeoutError.ts';

/**
 * Marks an error so mwn's retry ladder leaves it alone. `handleRequestFailure`
 * in mwn's core checks this flag before deciding a failure is transient.
 */
interface RetryableError {
	disableRetry?: boolean;
}

/**
 * Returns a view of `bot` whose MediaWiki API calls stop when `deadline`
 * expires, and when the caller walks away if a `cancellation` signal is given.
 *
 * One deadline armed outside the view and shared by every request it makes is
 * what bounds the retry LADDER rather than one attempt: mwn's own 60s cap is
 * per attempt, and two of its retry branches nest requests that each get a
 * fresh budget.
 *
 * Every API call mwn makes funnels through `rawRequest` — `request()` calls it
 * directly and `query()` goes through `request()` — so intercepting that one
 * method covers every call that enters through this view, without touching any
 * tool. The interception is a Proxy rather than a subclass or a clone because
 * mwn caches CSRF tokens and login state as plain instance fields: a Proxy
 * forwards those reads and writes to the shared cached instance, where
 * `Object.create` would shadow every write onto a throwaway object and silently
 * re-fetch a token per request. Methods are returned unbound on purpose, so
 * `this` inside them is the Proxy and mwn's own internal `this.rawRequest(...)`
 * calls are intercepted too.
 *
 * That last property is why anything wrapped *inside* this view must preserve
 * the receiver: a layer that rebinds `this` to the bare instance cuts this
 * Proxy out of every internal hop and the bound silently stops applying. See
 * the note in `mwnErrorSanitizer.ts`, which sits inside this one.
 *
 * Not covered: the `Page`/`File`/`Category`/`User`/`Wikitext` helper classes mwn
 * builds in its constructor close over the bare instance, so calls made through
 * them never re-enter this Proxy. Nothing in `src/` uses them; a tool that
 * reached for `bot.page(...)` would quietly lose both bounds.
 *
 * An abandoned request also has to be marked `disableRetry`. mwn treats a
 * rejection that carries no HTTP response as transient and retries it, and an
 * aborted request has none — so an untreated abort sleeps through the whole
 * retry ladder before giving up, making the bound slower than letting the
 * request finish. An expired deadline carries the flag on `WikiTimeoutError`.
 */
export function withCallBounds(bot: Mwn, deadline: CallDeadline, cancellation?: AbortSignal): Mwn {
	const signal =
		cancellation === undefined ? deadline.signal : AbortSignal.any([deadline.signal, cancellation]);
	return new Proxy(bot, {
		get(target, prop, receiver): unknown {
			if (prop === 'massQuery') {
				// `massQuery` puts per-batch errors IN its result array instead of
				// rejecting, so a stopped batch arrives as data: `get-pages` skips an
				// entry with no `query` and reports every page as missing, and
				// `mwn.read` dereferences it into a TypeError. Ordinary per-batch
				// failures are left alone, as mwn intends.
				return async (...args: Parameters<Mwn['massQuery']>): Promise<unknown> => {
					// Applied to the receiver so the internal `this.request` hop stays
					// bounded.
					const responses = await bot.massQuery.apply(receiver, args);
					if (signal.aborted) {
						const failure = responses.find((response) => response instanceof Error);
						if (failure) {
							throw failure;
						}
					}
					return responses;
				};
			}
			if (prop !== 'rawRequest') {
				return Reflect.get(target, prop, receiver);
			}
			return async (requestOptions: RawRequestParams): Promise<unknown> => {
				try {
					return await target.rawRequest({ ...requestOptions, signal });
				} catch (err: unknown) {
					if (signal.aborted) {
						// `AbortSignal.any` forwards the winning signal's own reason
						// object, so identity says which of the two fired first.
						if (deadline.signal.aborted && signal.reason === deadline.signal.reason) {
							throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
						}
						// Best-effort: a frozen error would throw on assignment in strict
						// mode and replace the real failure with a TypeError.
						if (typeof err === 'object' && err !== null && Object.isExtensible(err)) {
							(err as RetryableError).disableRetry = true;
						}
					}
					throw err;
				}
			};
		},
	});
}
