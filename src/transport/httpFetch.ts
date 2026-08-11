import fetch, { Response, FetchError } from 'node-fetch';
import { USER_AGENT } from '../runtime/constants.ts';
import { isErrnoException } from '../errors/isErrnoException.ts';
import { assertPublicDestination, buildPinnedAgent, SsrfValidationError } from './ssrfGuard.ts';

const MAX_REDIRECTS = 5;

// Node syscall error codes that mean "the server could not reach the source"
// (DNS failure, connection refused/reset, unreachable/timed-out). These should
// rescue to wiki-side copy-upload — the wiki may reach a host the server can't.
// DNS failures (ENOTFOUND/EAI_AGAIN) surface from assertPublicDestination's
// lookup BEFORE node-fetch runs, so they arrive as plain Errors with a code
// rather than as a node-fetch FetchError.
const RESCUABLE_SYSCALL_CODES = new Set([
	'ENOTFOUND',
	'EAI_AGAIN',
	'ECONNREFUSED',
	'ECONNRESET',
	'ETIMEDOUT',
	'EHOSTUNREACH',
	'ENETUNREACH',
]);

const DEFAULT_UPLOAD_MAX_BYTES = 100 * 1024 * 1024; // 100 MB
const FETCH_TIMEOUT_MS = 30_000;

// Operator-owned cap on the server-side fetch used by upload-file-from-url /
// update-file-from-url. Guards THIS server's memory; the wiki's own
// $wgMaxUploadSize is separate. Over-cap is not fatal — the tools route to
// wiki-side copy-upload instead.
function resolveUploadMaxBytes(): number {
	const raw = process.env.MCP_UPLOAD_MAX_BYTES;
	if (raw === undefined || raw === '') {
		return DEFAULT_UPLOAD_MAX_BYTES;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		return DEFAULT_UPLOAD_MAX_BYTES;
	}
	return parsed;
}

/** A fetched URL responded with a non-2xx status: the source was reachable but rejected the request. */
export class HttpStatusError extends Error {
	public readonly status: number;
	/** The response body, kept apart from the message for callers that report the source's own diagnostics. */
	public readonly body?: string;
	public constructor(status: number, url: string, body?: string) {
		super(`HTTP error! status: ${status} for URL: ${url}.${body ? ` Response: ${body}` : ''}`);
		this.name = 'HttpStatusError';
		this.status = status;
		this.body = body;
	}
}

/** A fetched body exceeded the server-side size cap for the fetch that asked for it. */
export class FileTooLargeError extends Error {
	public readonly size: number;
	public readonly limit: number;
	/** `limitName` names the setting behind the cap, when a setting is what set it. */
	public constructor(size: number, limit: number, limitName?: string) {
		const source = limitName === undefined ? '' : ` (${limitName})`;
		super(`Fetched body is ${size} bytes, over the ${limit}-byte limit${source}.`);
		this.name = 'FileTooLargeError';
		this.size = size;
		this.limit = limit;
	}
}

// Only 307 and 308 ask for the original method and body again: RFC 9110 makes a
// 303 a bodyless GET, and 301 and 302 are treated the same way. The requests
// this module sends are GET and POST, for which every other status means GET; a
// caller sending PUT or DELETE would need the status paired with the method.
const METHOD_PRESERVING_REDIRECTS = new Set([307, 308]);

// Headers that describe a request body go when the body goes: a bodyless GET
// announcing a Content-Type describes something it is not sending.
const BODY_HEADERS = new Set([
	'content-encoding',
	'content-language',
	'content-location',
	'content-type',
]);

function withoutBodyHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(
		Object.entries(headers).filter(([name]) => !BODY_HEADERS.has(name.toLowerCase())),
	);
}

async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
		method?: string;
		body?: string;
		signal?: AbortSignal;
	},
): Promise<Response> {
	let url = baseUrl;

	if (url.startsWith('//')) {
		url = 'https:' + url;
	}

	if (options?.params) {
		const queryString = new URLSearchParams(options.params).toString();
		if (queryString) {
			url = `${url}?${queryString}`;
		}
	}

	let requestHeaders: Record<string, string> = {
		'User-Agent': USER_AGENT,
	};

	if (options?.headers) {
		Object.assign(requestHeaders, options.headers);
	}

	let currentUrl = url;
	let currentMethod = options?.method || 'GET';
	let currentBody = options?.body;
	let response: Response | undefined;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const addresses = await assertPublicDestination(currentUrl);
		const agent = buildPinnedAgent(currentUrl, addresses);
		// Handed a body and a signal that is already aborted, node-fetch destroys
		// the body stream before anything subscribes to it, and the unhandled
		// 'error' event takes the process down. The DNS lookup above is a window
		// wide enough for a cancellation to land in, once per hop, so refuse the
		// request here instead. Throwing the signal's own reason keeps the
		// AbortError callers classify on.
		options?.signal?.throwIfAborted();
		response = await fetch(currentUrl, {
			headers: requestHeaders,
			method: currentMethod,
			...(currentBody !== undefined ? { body: currentBody } : {}),
			redirect: 'manual',
			agent,
			signal: options?.signal,
		});

		if (response.status < 300 || response.status >= 400) {
			break;
		}

		const location = response.headers.get('location');
		if (!location) {
			break;
		}

		if (hop === MAX_REDIRECTS) {
			throw new Error(`Too many redirects (>${MAX_REDIRECTS}) starting from ${url}`);
		}

		currentUrl = new URL(location, currentUrl).toString();
		// A downgrade holds for the rest of the chain: once the request is a
		// bodyless GET, a later 307 has a bodyless GET to preserve.
		if (!METHOD_PRESERVING_REDIRECTS.has(response.status)) {
			currentMethod = 'GET';
			currentBody = undefined;
			requestHeaders = withoutBodyHeaders(requestHeaders);
		}
	}

	// response is always assigned inside the loop (loop runs at least once).
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- definite-assignment via the loop's at-least-once invariant; TS can't prove it
	const finalResponse = response as Response;
	if (!finalResponse.ok) {
		const errorBody = await finalResponse.text().catch(() => '');
		throw new HttpStatusError(finalResponse.status, finalResponse.url, errorBody);
	}
	return finalResponse;
}

export async function makeApiRequest<T>(
	url: string,
	params?: Record<string, string>,
	options?: { signal?: AbortSignal },
): Promise<T> {
	const response = await fetchCore(url, {
		params,
		headers: { Accept: 'application/json' },
		signal: options?.signal,
	});
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- HTTP response body; trusted JSON envelope at this boundary
	return (await response.json()) as T;
}

/**
 * POSTs a form-encoded body through the SSRF guard and returns the response
 * text. For APIs that take a payload too large or too structured for a query
 * string — notably SPARQL endpoints, whose protocol defines this encoding.
 *
 * `maxBytes` caps what is read into memory, refusing an over-cap body by its
 * declared length and again by what actually arrives; without it the response is
 * buffered whole.
 *
 * Throws HttpStatusError (carrying the response body, which such APIs use to
 * explain what they rejected) on a non-2xx, FileTooLargeError over the cap, and
 * the same reachability errors as the rest of this module otherwise.
 */
export async function postForm(
	url: string,
	form: Record<string, string>,
	options?: { headers?: Record<string, string>; signal?: AbortSignal; maxBytes?: number },
): Promise<string> {
	const response = await fetchCore(url, {
		method: 'POST',
		body: new URLSearchParams(form).toString(),
		headers: { ...options?.headers, 'Content-Type': 'application/x-www-form-urlencoded' },
		signal: options?.signal,
	});
	if (options?.maxBytes === undefined) {
		return await response.text();
	}
	return (await readCapped(response, options.maxBytes)).toString('utf8');
}

/**
 * Reads a response body into memory under a byte cap, checked twice: the
 * declared content-length rejects an over-cap body before a byte is read, and
 * the running total catches one that under-declares or declares nothing.
 */
async function readCapped(
	response: Response,
	maxBytes: number,
	limitName?: string,
): Promise<Buffer> {
	const declared = Number(response.headers.get('content-length'));
	if (Number.isFinite(declared) && declared > maxBytes) {
		throw new FileTooLargeError(declared, maxBytes, limitName);
	}
	const chunks: Buffer[] = [];
	let total = 0;
	if (response.body !== null) {
		// node-fetch v3 exposes the body as a Node Readable (async-iterable).
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node-fetch v3 body is always a Node.js Readable; narrowing to AsyncIterable<Buffer> is safe at this boundary
		for await (const chunk of response.body as AsyncIterable<Buffer>) {
			total += chunk.length;
			if (total > maxBytes) {
				throw new FileTooLargeError(total, maxBytes, limitName);
			}
			chunks.push(chunk);
		}
	}
	return Buffer.concat(chunks);
}

export async function fetchPageHtml(url: string): Promise<string | null> {
	try {
		const response = await fetchCore(url);
		return await response.text();
	} catch {
		return null;
	}
}

/**
 * Fetches a URL's bytes through the SSRF guard (DNS pinning, redirect validation),
 * enforcing a size cap and an overall timeout. Used to upload an arbitrary,
 * untrusted source URL to a wiki without relying on the wiki's copy-upload
 * feature — and without sending the wiki's credentials to the source host.
 *
 * Throws: SsrfValidationError (non-public address), FileTooLargeError (over cap),
 * HttpStatusError (source returned non-2xx), or node-fetch FetchError / AbortError
 * (unreachable / timed out). Callers use shouldRescueToWiki() to decide whether to
 * fall back to wiki-side copy-upload.
 */
export async function fetchFileBytes(
	url: string,
	options?: { maxBytes?: number; timeoutMs?: number },
): Promise<Buffer> {
	const maxBytes = options?.maxBytes ?? resolveUploadMaxBytes();
	const timeoutMs = options?.timeoutMs ?? FETCH_TIMEOUT_MS;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	try {
		return await readCapped(
			await fetchCore(url, { signal: controller.signal }),
			maxBytes,
			'MCP_UPLOAD_MAX_BYTES',
		);
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Whether a failed server-side fetch should fall back to wiki-side copy-upload.
 * Rescue when the server couldn't obtain the bytes for a reachability/size
 * reason (the wiki might still reach the source); do NOT rescue when the source
 * was reached and rejected the request (the wiki would hit the same response).
 */
export function shouldRescueToWiki(error: unknown): boolean {
	if (error instanceof HttpStatusError) {
		return false;
	}
	if (
		error instanceof FileTooLargeError ||
		error instanceof SsrfValidationError ||
		error instanceof FetchError
	) {
		return true;
	}
	if (isErrnoException(error)) {
		if (error.name === 'AbortError') {
			return true;
		}
		if (typeof error.code === 'string' && RESCUABLE_SYSCALL_CODES.has(error.code)) {
			return true;
		}
	}
	return false;
}
