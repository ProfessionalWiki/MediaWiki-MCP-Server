import { AsyncLocalStorage } from 'node:async_hooks';
import type { CallDeadline } from './callDeadline.ts';
import { hashCaller } from './instrument.ts';

/**
 * A token the request acts with, and the one wiki it may be sent to. A token the
 * caller forwarded names none (null): which wiki it is for is the caller's to
 * choose.
 */
export interface RuntimeToken {
	value: string;
	wikiKey: string | null;
}

interface RequestContext {
	runtimeToken?: RuntimeToken;
	wikiKey?: string;
	signal?: AbortSignal;
	deadline?: CallDeadline;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

/** The token a request to `wikiKey` may carry, if the request holds one for it. */
export function getRuntimeToken(wikiKey: string): string | undefined {
	const token = runtimeTokenStore.getStore()?.runtimeToken;
	if (token !== undefined && (token.wikiKey === null || token.wikiKey === wikiKey)) {
		return token.value;
	}
	return undefined;
}

/** The caller's identity for telemetry: a digest of its token, never the token. */
export function getCallerId(): string {
	return hashCaller(runtimeTokenStore.getStore()?.runtimeToken?.value);
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
	runtimeToken: RuntimeToken | undefined,
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
