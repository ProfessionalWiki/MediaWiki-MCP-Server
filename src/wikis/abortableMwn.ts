import type { Mwn, RawRequestParams } from 'mwn';

/**
 * Marks an error so mwn's retry ladder leaves it alone. `handleRequestFailure`
 * in mwn's core checks this flag before deciding a failure is transient.
 */
interface RetryableError {
	disableRetry?: boolean;
}

/**
 * Returns a view of `bot` whose MediaWiki API calls carry `signal`, so an
 * abandoned request stops hitting the wiki instead of running to completion.
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
 * Proxy out of every internal hop and the signal silently stops applying. See
 * the note in `mwnErrorSanitizer.ts`, which sits inside this one.
 *
 * Not covered: the `Page`/`File`/`Category`/`User`/`Wikitext` helper classes mwn
 * builds in its constructor close over the bare instance, so calls made through
 * them never re-enter this Proxy. Nothing in `src/` uses them; a tool that
 * reached for `bot.page(...)` would quietly lose cancellation.
 *
 * The abort also has to be marked `disableRetry`. mwn treats a rejection that
 * carries no HTTP response as transient and retries it, and an aborted request
 * has no response — so an untreated abort sleeps through the whole retry ladder
 * (3 retries, 5s apart by default) before giving up, making cancellation slower
 * than letting the request finish.
 */
export function withAbortSignal(bot: Mwn, signal: AbortSignal): Mwn {
	return new Proxy(bot, {
		get(target, prop, receiver): unknown {
			if (prop !== 'rawRequest') {
				return Reflect.get(target, prop, receiver);
			}
			return async (requestOptions: RawRequestParams): Promise<unknown> => {
				try {
					return await target.rawRequest({ ...requestOptions, signal });
				} catch (err: unknown) {
					if (signal.aborted && typeof err === 'object' && err !== null) {
						// Best-effort: a frozen error would throw on assignment in strict
						// mode and replace the real failure with a TypeError.
						if (Object.isExtensible(err)) {
							(err as RetryableError).disableRetry = true;
						}
					}
					throw err;
				}
			};
		},
	});
}
