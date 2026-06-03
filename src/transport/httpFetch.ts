import fetch, { Response, FetchError } from 'node-fetch';
import { USER_AGENT } from '../runtime/constants.js';
import { isErrnoException } from '../errors/isErrnoException.js';
import { assertPublicDestination, buildPinnedAgent, SsrfValidationError } from './ssrfGuard.js';

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
	public constructor(status: number, url: string, body?: string) {
		super(`HTTP error! status: ${status} for URL: ${url}.${body ? ` Response: ${body}` : ''}`);
		this.name = 'HttpStatusError';
		this.status = status;
	}
}

/** A fetched body exceeded the server-side size cap (MCP_UPLOAD_MAX_BYTES). */
export class FileTooLargeError extends Error {
	public readonly size: number;
	public readonly limit: number;
	public constructor(size: number, limit: number) {
		super(`Fetched file is ${size} bytes, over the ${limit}-byte limit (MCP_UPLOAD_MAX_BYTES).`);
		this.name = 'FileTooLargeError';
		this.size = size;
		this.limit = limit;
	}
}

async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
		method?: string;
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

	const requestHeaders: Record<string, string> = {
		'User-Agent': USER_AGENT,
	};

	if (options?.headers) {
		Object.assign(requestHeaders, options.headers);
	}

	let currentUrl = url;
	let response: Response | undefined;
	for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
		const addresses = await assertPublicDestination(currentUrl);
		const agent = buildPinnedAgent(currentUrl, addresses);
		response = await fetch(currentUrl, {
			headers: requestHeaders,
			method: options?.method || 'GET',
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
		const response = await fetchCore(url, { signal: controller.signal });
		const declared = Number(response.headers.get('content-length'));
		if (Number.isFinite(declared) && declared > maxBytes) {
			throw new FileTooLargeError(declared, maxBytes);
		}
		const chunks: Buffer[] = [];
		let total = 0;
		if (response.body !== null) {
			// node-fetch v3 exposes the body as a Node Readable (async-iterable).
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node-fetch v3 body is always a Node.js Readable; narrowing to AsyncIterable<Buffer> is safe at this boundary
			for await (const chunk of response.body as AsyncIterable<Buffer>) {
				total += chunk.length;
				if (total > maxBytes) {
					throw new FileTooLargeError(total, maxBytes);
				}
				chunks.push(chunk);
			}
		}
		return Buffer.concat(chunks);
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
