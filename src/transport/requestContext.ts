import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
	runtimeToken?: string;
	sessionId?: string;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}

export function getSessionId(): string | undefined {
	return runtimeTokenStore.getStore()?.sessionId;
}
