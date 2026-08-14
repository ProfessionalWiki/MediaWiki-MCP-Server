import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * A bot-password pair the CALLER supplied for this request (HTTP transport,
 * `Authorization: Basic`). Held for the request scope only: nothing writes it to
 * disk, and it never reaches a log line — the caller identity telemetry records
 * is derived through getCallerSecret() and hashed.
 */
export interface RuntimeCredentials {
	readonly username: string;
	readonly password: string;
}

interface RequestContext {
	runtimeToken?: string;
	runtimeCredentials?: RuntimeCredentials;
	wikiKey?: string;
	signal?: AbortSignal;
}

// The two ways a request can carry a caller identity. A request has at most one:
// they arrive in the same Authorization header under different schemes.
export interface RequestIdentity {
	runtimeToken?: string;
	runtimeCredentials?: RuntimeCredentials;
}

export const runtimeTokenStore = new AsyncLocalStorage<RequestContext>();

export function getRuntimeToken(): string | undefined {
	return runtimeTokenStore.getStore()?.runtimeToken;
}

export function getRuntimeCredentials(): RuntimeCredentials | undefined {
	return runtimeTokenStore.getStore()?.runtimeCredentials;
}

/**
 * Whether this request acts as somebody: a token, or caller-supplied bot-password
 * credentials. The negation is what "anonymous" means to the capability guard —
 * which must not read the token alone, or a Basic-authenticated caller would be
 * refused the tools their own credentials authorise.
 */
export function isRequestAuthenticated(): boolean {
	const store = runtimeTokenStore.getStore();
	return store?.runtimeToken !== undefined || store?.runtimeCredentials !== undefined;
}

/**
 * The secret telemetry hashes into a stable per-caller id. A token identifies its
 * bearer directly; for credentials the USERNAME does, so the password stays out
 * of it entirely — two sessions of one bot account should hash alike, and a
 * rotated password must not read as a different caller.
 */
export function getCallerSecret(): string | undefined {
	const store = runtimeTokenStore.getStore();
	if (store?.runtimeToken !== undefined) {
		return store.runtimeToken;
	}
	const credentials = store?.runtimeCredentials;
	return credentials ? `basic:${credentials.username}` : undefined;
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
	return withRequestIdentity({ runtimeToken }, fn);
}

/**
 * Opens a request scope carrying whichever identity the transport resolved — a
 * token, caller-supplied credentials, or neither. Replaces the scope rather than
 * merging onto it (unlike withRequestFields): it runs at the transport boundary,
 * where there is nothing yet to keep.
 */
export function withRequestIdentity<T>(
	identity: RequestIdentity,
	fn: () => Promise<T>,
): Promise<T> {
	return runtimeTokenStore.run({ ...identity }, fn);
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
 * Runs `fn` with the cancellation signal detached, keeping the rest of the
 * scope (notably the runtime token, which the call still needs to authenticate).
 *
 * For work that outlives the request that happened to trigger it: a result
 * shared between concurrent callers must not be torn down because the first
 * caller to arrive walked away, which would hand every other waiter the
 * failure path.
 */
export function withoutRequestSignal<T>(fn: () => Promise<T>): Promise<T> {
	return withRequestFields({ signal: undefined }, fn);
}
