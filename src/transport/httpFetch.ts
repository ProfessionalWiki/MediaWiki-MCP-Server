import { Readable } from 'node:stream';
import fetch, { Response, FetchError } from 'node-fetch';
import { USER_AGENT } from '../runtime/constants.ts';
import { isErrnoException } from '../errors/isErrnoException.ts';
import { assertPublicDestination, buildPinnedAgent, SsrfValidationError } from './ssrfGuard.ts';
import {
	firstRequest,
	nextHop,
	type FetchSpec,
	type HopRequest,
	type HopResponse,
} from './requestChain.ts';

/** What a caller passes to `fetchCore`: the request itself, plus its cancellation. */
type FetchOptions = FetchSpec & { signal?: AbortSignal };

/**
 * A failing source's own explanation is worth reporting, and its length is the
 * source's choice, so this much of it is read and the rest abandoned.
 */
const MAX_ERROR_BODY_BYTES = 8 * 1024;

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

/**
 * Drives a request through its redirect chain. Every rule about which hops to
 * follow lives in `nextHop`; this performs the I/O each decision asks for. A
 * response that is not delivered leaves through one place, which is what keeps
 * every abandoned body — followed hop, refusal and cap alike — from stranding
 * its connection.
 */
async function fetchCore(baseUrl: string, options?: FetchOptions): Promise<Response> {
	let request = firstRequest(baseUrl, options);
	for (;;) {
		const response = await sendHop(request, options?.signal);
		const decision = nextHop(request, readHop(response));
		if (decision.kind === 'deliver') {
			return await delivered(response);
		}
		destroyBody(response);
		if (decision.kind === 'refuse') {
			throw decision.error;
		}
		request = decision.request;
	}
}

/** Sends one hop, through the SSRF guard and an agent pinned to what it resolved. */
async function sendHop(request: HopRequest, signal?: AbortSignal): Promise<Response> {
	const addresses = await assertPublicDestination(request.url);
	const agent = buildPinnedAgent(request.url, addresses);
	// Handed a body and a signal that is already aborted, node-fetch destroys
	// the body stream before anything subscribes to it, and the unhandled
	// 'error' event takes the process down. The DNS lookup above is a window
	// wide enough for a cancellation to land in, once per hop, so refuse the
	// request here instead. Throwing the signal's own reason keeps the
	// AbortError callers classify on.
	signal?.throwIfAborted();
	return await fetch(request.url, {
		headers: { 'User-Agent': USER_AGENT, ...request.headers },
		method: request.method,
		...(request.body === undefined ? {} : { body: request.body }),
		redirect: 'manual',
		agent,
		signal,
	});
}

/** The two fields the redirect decision reads, and nothing else. */
function readHop(response: Response): HopResponse {
	return { status: response.status, location: response.headers.get('location') };
}

/** A 2xx passes through; anything else becomes the source's own diagnostics. */
async function delivered(response: Response): Promise<Response> {
	if (response.ok) {
		return response;
	}
	const errorBody = await readTruncated(response, MAX_ERROR_BODY_BYTES).catch(() => '');
	throw new HttpStatusError(response.status, response.url, errorBody);
}

/**
 * Reads at most `maxBytes` of a body and abandons the rest. Truncating rather
 * than refusing, because this reads the diagnostics of a failure that is already
 * being reported: a cap that threw would replace the source's explanation with
 * nothing, on a body whose size the source chooses.
 */
async function readTruncated(response: Response, maxBytes: number): Promise<string> {
	const chunks: Buffer[] = [];
	let total = 0;
	if (response.body !== null) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- node-fetch v3 body is always a Node.js Readable; narrowing to AsyncIterable<Buffer> is safe at this boundary
		for await (const chunk of response.body as AsyncIterable<Buffer>) {
			chunks.push(chunk);
			total += chunk.length;
			if (total >= maxBytes) {
				break;
			}
		}
	}
	destroyBody(response);
	return Buffer.concat(chunks).toString('utf8').slice(0, maxBytes);
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
 *
 * Either refusal disposes of the body first: the connection is held for as long
 * as the body stream is neither consumed nor destroyed, so a body left unread
 * strands a socket until something aborts the request — which, on the upload
 * path, nothing does.
 */
async function readCapped(
	response: Response,
	maxBytes: number,
	limitName?: string,
): Promise<Buffer> {
	try {
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
	} catch (error) {
		destroyBody(response);
		throw error;
	}
}

/**
 * Releases the connection behind a response body that will not be read. Leaving
 * the read loop above destroys the stream on its way out, but a refusal that
 * never subscribes to it has to do this itself.
 */
function destroyBody(response: Response): void {
	// node-fetch v3 hands back a Node Readable, but declares it as the wider
	// NodeJS.ReadableStream, which has no destroy(). Narrowing by instanceof
	// rather than asserting means a body that is not a Node stream is left
	// alone instead of throwing over the refusal being reported.
	if (response.body instanceof Readable) {
		response.body.destroy();
	}
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
