import { AsyncLocalStorage } from 'node:async_hooks';

interface RequestContext {
	runtimeToken?: string;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}
