import type { WikiTimeoutPhase } from '../errors/wikiTimeoutError.ts';

/**
 * The budget one tool call gets for all of its wiki traffic, retries included.
 * Sized against the longest legitimate call, a cold-wiki `upload-file-from-url`:
 * WIKI_CONNECT_TIMEOUT_MS signing in, FETCH_TIMEOUT_MS fetching the source, then
 * the upload POST under mwn's own 60s cap — the first two on their own timers,
 * only sharing this clock. An {exec:…} credential can spend 30s ahead of them.
 */
export const WIKI_CALL_TIMEOUT_MS = 150_000;

/**
 * The budget for reaching a wiki the first time; mwn's login is three
 * sub-second round-trips. Independent of the call's budget rather than nested
 * inside it, because the connection is shared work — see `withSharedWorkScope`.
 */
export const WIKI_CONNECT_TIMEOUT_MS = 30_000;

/**
 * `AbortSignal.timeout` carries neither its duration nor its meaning, so both
 * travel beside it. `phase` is fixed where the budget is armed rather than
 * where it expires, so a connect budget cannot forget to say that nothing the
 * caller asked for was sent.
 */
export interface CallDeadline {
	readonly signal: AbortSignal;
	readonly timeoutMs: number;
	readonly phase: WikiTimeoutPhase;
}

export function callDeadline(timeoutMs: number, phase: WikiTimeoutPhase): CallDeadline {
	return { signal: AbortSignal.timeout(timeoutMs), timeoutMs, phase };
}
