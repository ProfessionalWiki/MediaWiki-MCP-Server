import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
	runtimeToken?: string;
	wikiKey?: string;
	signal?: AbortSignal;
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
