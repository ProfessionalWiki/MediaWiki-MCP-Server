import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallDeadline } from './callDeadline.ts';

interface RequestContext {
	runtimeToken?: string;
	wikiKey?: string;
	signal?: AbortSignal;
	deadline?: CallDeadline;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}

// The MCP request's cancellation signal, aborted when the client cancels the
// request or the connection drops. Undefined outside a request scope.
export function getRequestSignal(): AbortSignal | undefined {
	return runtimeTokenStore.getStore()?.signal;
}

/**
 * The call's time budget. Kept apart from `signal` so code asking whether the
 * CALLER walked away cannot read a budget expiry as one.
 */
export function getRequestDeadline(): CallDeadline | undefined {
	return runtimeTokenStore.getStore()?.deadline;
}

export function getRequestWiki(): string | undefined {
	return runtimeTokenStore.getStore()?.wikiKey;
}

export function withRequestContext<T>(
	runtimeToken: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return runtimeTokenStore.run({ runtimeToken }, fn);
}

// Merges `fields` onto the current context (or an empty one) rather than
// replacing it — so adding a wikiKey, then later a runtimeToken, keeps both.
export function withRequestFields<T>(
	fields: Partial<RequestContext>,
	fn: () => Promise<T>,
): Promise<T> {
	const current = runtimeTokenStore.getStore() ?? {};
	return runtimeTokenStore.run({ ...current, ...fields }, fn);
}

/**
 * Runs `fn` detached from the caller that happened to trigger it, on `deadline`
 * rather than that caller's cancellation and remaining time.
 *
 * For work shared between concurrent callers: the first caller's cancellation
 * would fail every other waiter, and its leftover budget is just as arbitrary —
 * a joiner would inherit it, making its answer depend on an unrelated clock.
 */
export function withSharedWorkScope<T>(deadline: CallDeadline, fn: () => Promise<T>): Promise<T> {
	return withRequestFields({ signal: undefined, deadline }, fn);
}
