/**
 * The rules for following a redirect, as one pure decision.
 *
 * This module owns no sockets, no DNS and no clock: `nextHop` reads what was
 * sent and the status and Location that came back, and says whether to deliver
 * the response, send another request, or refuse. The transport drives it and
 * performs whatever the decision asks for, so each rule below is a value
 * assertion in a test rather than something only observable through a server.
 *
 * It follows the Fetch standard's HTTP-redirect fetch, with two deliberate
 * departures, both of which exist because this server fetches URLs a caller
 * chose:
 *
 * 1. A hop that would drop the request body is refused rather than performed.
 *    The standard re-sends a 301, 302 or 303 as a bodyless GET, but the one
 *    caller here that sends a body sends a SPARQL query in it, so that GET
 *    reaches the target with nothing to run and the target's answer describes a
 *    request nobody made. The published endpoint URL having moved is the fault
 *    worth reporting.
 * 2. A hop that drops from `https` to `http` is refused. The standard follows
 *    it, having only stripped the credentials.
 *
 * Credential headers are dropped across any change of origin, which is stricter
 * than node-fetch: it keeps them for a subdomain of the current host and ignores
 * the port, so a host that hands its tenants subdomains would forward one
 * tenant's credentials to another.
 */

/** Redirects this server follows. Every other 3xx is delivered as the status it is. */
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** The two that ask for the original method and body again. */
const BODY_PRESERVING_STATUSES = new Set([307, 308]);

/** Headers that authenticate the request they are sent on, and so belong to one origin. */
const CREDENTIAL_HEADERS = new Set(['authorization', 'www-authenticate', 'cookie', 'cookie2']);

/** Hops followed before the chain is refused. */
export const MAX_REDIRECTS = 5;

/**
 * A redirect asked for the request to be re-sent without its body. `target` is
 * the absolute URL that was not followed; it is kept off the message, because a
 * URL derived from a configured endpoint can carry that endpoint's credentials,
 * and the message reaches both the caller and the logs.
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

/**
 * A redirect pointed from `https` to `http`. Following it would put the rest of
 * the exchange, including anything already sent, on the wire in clear text.
 * `target` is withheld from the message for the same reason as above.
 */
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

/** What a caller asks for, before any of it reaches a socket. */
export interface FetchSpec {
	params?: Record<string, string>;
	headers?: Record<string, string>;
	/** Present means POST; absent means GET. A bodyless POST is not representable. */
	body?: string;
}

/** One request in a chain: what to send, and where it sits in the chain. */
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

/** The first request of a chain, from what the caller asked for. */
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
 * What to do with the response to `sent`. Guard clauses in the order the rules
 * apply: a non-redirect is delivered, then the cap, then the Location has to
 * parse, then the two refusals, then the hop is followed.
 *
 * These rules all precede the transport's own per-hop address check, since they
 * cost nothing and it costs a DNS lookup. So a hop that is both insecure and
 * bound for a private address is reported as the insecure one; both refuse it.
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
	// A body only survives a 307 or 308, and a hop that would drop one was
	// refused above, so the method and body carry over untouched.
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

// A protocol-relative URL is what a wiki's own configuration hands us for a
// server address, and it means https here.
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
