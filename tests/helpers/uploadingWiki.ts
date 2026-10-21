import { PassThrough } from 'node:stream';
import { vi, type Mock } from 'vitest';
import { Mwn } from 'mwn';
import type { ToolContext } from '../../src/runtime/context.ts';
import { contextWritingTo, type WritingWiki } from './writingWiki.ts';

/** The multipart body mwn hands its HTTP layer: a form-data stream. */
interface MultipartBody {
	getBoundary(): string;
	pipe<T extends NodeJS.WritableStream>(destination: T): T;
}

/** How long the fake wiki waits on an upload body that has stopped arriving. */
const STALLED_BODY_MS = 1000;

export interface UploadReceivingWiki {
	mwn: Mwn;
	/** The parts of each upload the wiki received, by name, as far as each arrived. */
	uploads: Record<string, string>[];
}

/**
 * A real Mwn with only its HTTP layer stubbed, so mwn's own retries run. The
 * wiki hands out a CSRF token and answers the uploads it receives with
 * `answers`, in order.
 */
export function wikiReceivingUploads(...answers: object[]): UploadReceivingWiki {
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	const uploads: Record<string, string>[] = [];
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: {
		params?: Record<string, string>;
		data?: unknown;
	}) => {
		if (request.params?.meta === 'tokens') {
			return { data: { query: { tokens: { csrftoken: 'csrf-token' } } } };
		}
		// mwn asks which token an action takes before it retries a `badtoken`.
		if (
			typeof request.data === 'string' &&
			new URLSearchParams(request.data).get('action') === 'paraminfo'
		) {
			return {
				data: {
					paraminfo: { modules: [{ parameters: [{ name: 'token', tokentype: 'csrf' }] }] },
				},
			};
		}
		if (typeof request.data !== 'object' || request.data === null) {
			// Without `disableRetry`, mwn retries the error as a failed connection
			// until the test times out.
			throw Object.assign(
				new Error(
					`wikiReceivingUploads: unexpected request ${JSON.stringify(request.params ?? request.data)}`,
				),
				{ disableRetry: true },
			);
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one object body mwn sends is a multipart upload
		const body = request.data as MultipartBody;
		uploads.push(partsOf(await received(body), body.getBoundary()));
		return { data: answers[uploads.length - 1] };
	}) as never);
	return { mwn, uploads };
}

function received(body: MultipartBody): Promise<string> {
	return new Promise((resolve) => {
		const chunks: Buffer[] = [];
		const sink = new PassThrough();
		const settle = (): void => {
			clearTimeout(stalled);
			resolve(Buffer.concat(chunks).toString());
		};
		const stalled = setTimeout(settle, STALLED_BODY_MS);
		sink.on('data', (chunk: Buffer) => chunks.push(chunk));
		sink.on('end', settle);
		body.pipe(sink);
	});
}

function partsOf(body: string, boundary: string): Record<string, string> {
	const parts: Record<string, string> = {};
	for (const part of body.split(`--${boundary}`)) {
		const match = /name="([^"]+)"[\s\S]*?\r\n\r\n([\s\S]*)$/.exec(part);
		if (match !== null) {
			parts[match[1]] = match[2].replace(/\r\n$/, '');
		}
	}
	return parts;
}

export const UPLOADED = {
	result: 'Success',
	filename: 'Cat.jpg',
	imageinfo: {
		descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
		url: 'https://test.wiki/images/Cat.jpg',
	},
};

// The wiki's answers to an imageinfo query for a file it holds, and for one it does not.
export const FILE_EXISTS = {
	query: {
		pages: [{ title: 'File:Cat.jpg', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] }],
	},
};
export const FILE_MISSING = { query: { pages: [{ title: 'File:Cat.jpg', missing: true }] } };

// A context on `wiki` with the real edit service, except the multipart byte
// upload, which `writingWiki` cannot read: `uploadBytes` stands in for it.
export function contextUploadingTo(
	wiki: WritingWiki,
	uploadBytes: Mock = vi.fn().mockResolvedValue(UPLOADED),
	tags: string | null = null,
): ToolContext {
	const ctx = contextWritingTo(wiki, tags);
	Object.assign(ctx.edit, { submitUploadFromBytes: uploadBytes });
	return ctx;
}
