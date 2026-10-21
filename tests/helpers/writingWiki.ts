import { PassThrough } from 'node:stream';
import { vi } from 'vitest';
import { Mwn } from 'mwn';
import type { ToolContext } from '../../src/runtime/context.ts';
import { EditServiceImpl } from '../../src/services/editService.ts';
import { fakeContext, contextOn } from './fakeContext.ts';

export interface WritingWiki {
	mwn: Mwn;
	/** Every write the wiki received, in order, each as far as it arrived. */
	writes: URLSearchParams[];
	/** The last write the wiki received. */
	sentWrite: () => URLSearchParams;
}

/** The multipart body mwn hands its HTTP layer for an upload: a form-data stream. */
interface MultipartBody {
	getBoundary(): string;
	pipe<T extends NodeJS.WritableStream>(destination: T): T;
}

/** How long the fake wiki waits on an upload body that has stopped arriving. */
const STALLED_BODY_MS = 1000;

// A real Mwn with only its HTTP layer stubbed, so mwn's own parameter handling
// and retries run and the assertions see each write as the wiki receives it,
// including any default mwn adds on the way; an upload's file part holds the
// file's bytes as text. It hands out a CSRF token, answers a rights query with
// `rights` and any other query with `read`, and answers the writes with
// `response`, or with each of `response` in turn, the last repeating. mwn sends
// a query as a GET and every other action as a POST.
export function writingWiki(
	response: object | object[],
	wiki: { rights?: string[]; read?: object } = {},
): WritingWiki {
	const answers = Array.isArray(response) ? response : [response];
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	const writes: URLSearchParams[] = [];
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: {
		params?: Record<string, string>;
		data?: unknown;
	}) => {
		if (request.params?.meta === 'tokens') {
			return { data: { query: { tokens: { csrftoken: 'csrf-token' } } } };
		}
		if (request.params?.meta === 'userinfo') {
			return { data: { query: { userinfo: { rights: wiki.rights ?? [] } } } };
		}
		if (request.data === undefined) {
			return { data: wiki.read ?? {} };
		}
		if (typeof request.data === 'string') {
			const sent = new URLSearchParams(request.data);
			// mwn asks which token an action takes before it retries a `badtoken`.
			if (sent.get('action') === 'paraminfo') {
				return {
					data: {
						paraminfo: { modules: [{ parameters: [{ name: 'token', tokentype: 'csrf' }] }] },
					},
				};
			}
			writes.push(sent);
		} else {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- the one other body mwn sends is a multipart upload
			const body = request.data as MultipartBody;
			writes.push(partsOf(await received(body), body.getBoundary()));
		}
		return { data: answers[Math.min(writes.length, answers.length) - 1] };
	}) as never);
	return {
		mwn,
		writes,
		sentWrite: () => {
			const last = writes.at(-1);
			if (last === undefined) {
				throw new Error('No write reached the wiki');
			}
			return last;
		},
	};
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

function partsOf(body: string, boundary: string): URLSearchParams {
	const parts = new URLSearchParams();
	for (const part of body.split(`--${boundary}`)) {
		const match = /name="([^"]+)"[\s\S]*?\r\n\r\n([\s\S]*)$/.exec(part);
		if (match !== null) {
			parts.append(match[1], match[2].replace(/\r\n$/, ''));
		}
	}
	return parts;
}

/** A context writing to `wiki` through the real edit service, on a wiki configured with `tags`. */
export function contextWritingTo(wiki: WritingWiki, tags: string | null = null): ToolContext {
	const base = fakeContext();
	const activeWiki = {
		...base.activeWiki,
		get: () => {
			const { key, config } = base.activeWiki.get();
			return { key, config: { ...config, tags } };
		},
	};
	return contextOn(wiki.mwn, {
		activeWiki,
		edit: new EditServiceImpl(activeWiki),
	});
}
