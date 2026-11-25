import { Readable } from 'node:stream';
import type { Mwn } from 'mwn';
import { wikiAuthorization } from './wikiAuthorization.ts';

const MAX_REDIRECTS = 5;

export interface DownloadedFile {
	readonly bytes: Buffer;
	/** The response's media type, without parameters. */
	readonly contentType: string | undefined;
}

/**
 * Downloads a file URL the wiki's own imageinfo returned, through the client and identity that
 * read it, so any file the wiki describes to the caller can also be downloaded.
 */
export async function downloadFile(mwn: Mwn, url: string): Promise<DownloadedFile> {
	const response = await mwn.rawRequest({ ...fileRequest(mwn, url), responseType: 'arraybuffer' });
	return {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios arraybuffer body at this boundary
		bytes: Buffer.from(response.data as ArrayBuffer),
		contentType: contentTypeOf(response),
	};
}

/** Downloads at most the first `maxBytes` of a file, as `downloadFile` would, and abandons the rest. */
export async function downloadFilePrefix(
	mwn: Mwn,
	url: string,
	maxBytes: number,
): Promise<DownloadedFile> {
	const response = await streamedResponse(mwn, url);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios stream body at this boundary
	const body = response.data as Readable;
	const chunks: Buffer[] = [];
	let total = 0;
	for await (const chunk of body) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- a stream without an encoding yields Buffers
		const bytes = chunk as Buffer;
		chunks.push(bytes);
		total += bytes.length;
		if (total >= maxBytes) {
			break;
		}
	}
	body.destroy();
	return {
		bytes: Buffer.concat(chunks, Math.min(total, maxBytes)),
		contentType: contentTypeOf(response),
	};
}

// A refused streamed request leaves its body unread, holding the connection open until it is
// destroyed.
async function streamedResponse(
	mwn: Mwn,
	url: string,
): Promise<{ data: unknown; headers?: unknown }> {
	try {
		return await mwn.rawRequest({ ...fileRequest(mwn, url), responseType: 'stream' });
	} catch (err: unknown) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios error shape at this boundary
		const body = (err as { response?: { data?: unknown } } | undefined)?.response?.data;
		if (body instanceof Readable) {
			body.destroy();
		}
		throw err;
	}
}

// The URL comes from the configured wiki, unlike a caller-supplied one, so it is not
// SSRF-guarded. maxRedirects caps the number of hops but does not check where they lead.
function fileRequest(mwn: Mwn, url: string) {
	return {
		url,
		method: 'GET',
		maxRedirects: MAX_REDIRECTS,
		headers: wikiAuthorization(mwn, url),
	} as const;
}

function contentTypeOf(response: { headers?: unknown }): string | undefined {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- axios response headers at this boundary
	const headers = (response.headers ?? {}) as Record<string, unknown>;
	const contentType = headers['content-type'];
	return typeof contentType === 'string' ? contentType.split(';')[0]?.trim() : undefined;
}
