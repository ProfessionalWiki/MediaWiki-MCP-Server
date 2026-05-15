import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
	runtimeToken?: string;
	sessionId?: string;
	wikiKey?: string;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}

export function getSessionId(): string | undefined {
	return runtimeTokenStore.getStore()?.sessionId;
}

export function getRequestWiki(): string | undefined {
	return runtimeTokenStore.getStore()?.wikiKey;
}

export function withRequestContext<T>(
	runtimeToken: string | undefined,
	sessionId: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return runtimeTokenStore.run({ runtimeToken, sessionId }, fn);
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
