/**
 * The Fetch standard's HTTP-redirect fetch as one pure decision, departing from
 * the standard twice because the URLs here are a caller's to choose. It re-sends
 * a 301, 302 or 303 as a bodyless GET; this refuses that hop, since the one
 * caller that sends a body sends the whole request in it. It follows an `https`
 * to `http` hop with the credentials stripped; this refuses that too.
 *
 * Credentials go on any change of origin. node-fetch keeps them across a
 * subdomain and ignores the port, which on a host that gives its tenants
 * subdomains would hand one tenant's credentials to another.
 */

/** Every other 3xx is delivered as the status it is. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The two that ask for the original method and body again. */
const BODY_PRESERVING_STATUSES = new Set([307, 308]);

/** Headers that authenticate a request, and so belong to one origin. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'www-authenticate', 'cookie', 'cookie2']);

/** Hops followed before the chain is refused. */
export const MAX_REDIRECTS = 5;

/**
 * A redirect asked for the request to be re-sent without its body. `target` is
 * kept off the message: a URL derived from a configured endpoint can carry that
 * endpoint's credentials, and the message reaches the caller and the logs.
 */
export class RedirectDropsBodyError extends Error {
	public readonly status: number;
	public readonly target: string;
	public constructor(status: number, target: string) {
		super(`Refusing to follow an HTTP ${status} redirect: it would drop the request body.`);
		this.name = 'RedirectDropsBodyError';
		this.status = status;
		this.target = target;
	}
}

/** A redirect pointed from `https` to `http`. `target` is withheld as above. */
export class InsecureRedirectError extends Error {
	public readonly status: number;
	public readonly target: string;
	public constructor(status: number, target: string) {
		super(`Refusing to follow an HTTP ${status} redirect from https to http.`);
		this.name = 'InsecureRedirectError';
		this.status = status;
		this.target = target;
	}
}

/** A redirect's Location is not a URL, even read against the hop that sent it. */
export class UnusableLocationError extends Error {
	public readonly status: number;
	public constructor(status: number) {
		super(`An HTTP ${status} redirect gave a Location that is not a URL.`);
		this.name = 'UnusableLocationError';
		this.status = status;
	}
}

/** A chain asked for more hops than this server follows. */
export class TooManyRedirectsError extends Error {
	public readonly startUrl: string;
	public constructor(startUrl: string) {
		super(`Refusing to follow more than ${MAX_REDIRECTS} redirects starting from ${startUrl}.`);
		this.name = 'TooManyRedirectsError';
		this.startUrl = startUrl;
	}
}

/** A refusal to continue a chain. Every member carries the status that asked for it. */
export type RedirectRefusal =
	| RedirectDropsBodyError
	| InsecureRedirectError
	| UnusableLocationError
	| TooManyRedirectsError;

/** What a caller asks for. */
export interface FetchSpec {
	params?: Record<string, string>;
	headers?: Record<string, string>;
	/** Present means POST; absent means GET. A bodyless POST is not representable. */
	body?: string;
}

/** One request in a chain: what to send, and where it sits. */
export interface HopRequest {
	/** Absolute, with `params` already applied. */
	readonly url: string;
	readonly method: 'GET' | 'POST';
	readonly body?: string;
	readonly headers: Readonly<Record<string, string>>;
	readonly redirectsFollowed: number;
	/** The URL the chain began at, which the cap refusal names. Constant across the chain. */
	readonly startUrl: string;
}

/** The only parts of a response the decision reads. */
export interface HopResponse {
	readonly status: number;
	readonly location: string | null;
}

export type HopDecision =
	| { readonly kind: 'deliver' }
	| { readonly kind: 'follow'; readonly request: HopRequest }
	| { readonly kind: 'refuse'; readonly error: RedirectRefusal };

/** The first request of a chain. */
export function firstRequest(baseUrl: string, spec?: FetchSpec): HopRequest {
	const url = withParams(absolute(baseUrl), spec?.params);
	return {
		url,
		method: spec?.body === undefined ? 'GET' : 'POST',
		...(spec?.body === undefined ? {} : { body: spec.body }),
		headers: { ...spec?.headers },
		redirectsFollowed: 0,
		startUrl: url,
	};
}

/**
 * These rules run before the transport's per-hop address check, which costs a DNS
 * lookup, so a hop that is both insecure and bound for a private address is
 * reported as insecure. Both refuse it.
 */
export function nextHop(sent: HopRequest, received: HopResponse): HopDecision {
	if (!REDIRECT_STATUSES.has(received.status) || received.location === null) {
		return { kind: 'deliver' };
	}
	if (sent.redirectsFollowed === MAX_REDIRECTS) {
		return { kind: 'refuse', error: new TooManyRedirectsError(sent.startUrl) };
	}
	const target = resolveLocation(received.location, sent.url);
	if (target === undefined) {
		return { kind: 'refuse', error: new UnusableLocationError(received.status) };
	}
	const refusal = refusalFor(sent, received.status, target);
	if (refusal !== undefined) {
		return { kind: 'refuse', error: refusal };
	}
	return { kind: 'follow', request: followRequest(sent, target) };
}

function refusalFor(sent: HopRequest, status: number, target: URL): RedirectRefusal | undefined {
	const from = new URL(sent.url);
	if (from.protocol === 'https:' && target.protocol === 'http:') {
		return new InsecureRedirectError(status, target.toString());
	}
	if (sent.body !== undefined && !BODY_PRESERVING_STATUSES.has(status)) {
		return new RedirectDropsBodyError(status, target.toString());
	}
	return undefined;
}

function followRequest(sent: HopRequest, target: URL): HopRequest {
	const sameOrigin = new URL(sent.url).origin === target.origin;
	const headers = sameOrigin ? { ...sent.headers } : withoutCredentials(sent.headers);
	// A hop that would drop the body was refused above, so both carry over.
	return {
		url: target.toString(),
		method: sent.method,
		...(sent.body === undefined ? {} : { body: sent.body }),
		headers,
		redirectsFollowed: sent.redirectsFollowed + 1,
		startUrl: sent.startUrl,
	};
}

function withoutCredentials(headers: Readonly<Record<string, string>>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !CREDENTIAL_HEADERS.has(name.toLowerCase())),
	);
}

function resolveLocation(location: string, base: string): URL | undefined {
	try {
		return new URL(location, base);
	} catch {
		return undefined;
	}
}

// A wiki's own configuration hands us these for a server address.
function absolute(baseUrl: string): string {
	return baseUrl.startsWith('//') ? `https:${baseUrl}` : baseUrl;
}

function withParams(url: string, params?: Record<string, string>): string {
	if (params === undefined) {
		return url;
	}
	const queryString = new URLSearchParams(params).toString();
	return queryString === '' ? url : `${url}?${queryString}`;
}
