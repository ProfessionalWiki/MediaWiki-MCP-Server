import { createReadStream, type ReadStream } from 'node:fs';
import { basename } from 'node:path';
import type { ApiParams, Mwn } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { ApiUploadResponse } from 'mwn';
import type { WikiConfig } from '../config/loadConfig.ts';

export interface EditService {
	/** Wraps mwn.request with CSRF + tag injection + formatversion=2. For action:edit and similar. */
	submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown>;

	/** Uploads the file at `filepath` via a multipart action=upload. Injects CSRF token, tags, and ignorewarnings. */
	submitUpload(
		mwn: Mwn,
		filepath: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse>;

	/** Uploads in-memory bytes via a multipart action=upload — parallel to submitUpload but without a local filepath. Injects CSRF token, tags, and ignorewarnings. The bytes are passed to form-data as a Buffer (a plain Readable has no length and form-data rejects it with "Unknown stream"). */
	submitUploadFromBytes(
		mwn: Mwn,
		data: Buffer,
		filename: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse>;

	/**
	 * Reports whether the authenticated account holds the `bot` right on the
	 * targeted wiki — i.e. whether a bot-flagged edit will actually be marked.
	 * Resolves undefined when the rights probe fails; a probe failure never
	 * blocks a write. The probe is cached per Mwn instance; sessions that
	 * authenticate with a per-request bearer token get a fresh Mwn per call,
	 * so the probe re-runs for each bot-flagged edit there.
	 */
	botRight(mwn: Mwn): Promise<boolean | undefined>;
}

export class EditServiceImpl implements EditService {
	public constructor(private readonly tags: WikiConfig['tags']) {}

	private readonly botRightCache = new WeakMap<Mwn, Promise<boolean>>();

	public async botRight(mwn: Mwn): Promise<boolean | undefined> {
		let pending = this.botRightCache.get(mwn);
		if (!pending) {
			pending = this.queryBotRight(mwn);
			this.botRightCache.set(mwn, pending);
		}
		try {
			return await pending;
		} catch {
			// Drop the failed probe so the next bot-flagged edit retries instead
			// of pinning the failure for the lifetime of the Mwn instance. The
			// identity check keeps a late rejection from evicting a newer probe
			// that another caller has already reseeded.
			if (this.botRightCache.get(mwn) === pending) {
				this.botRightCache.delete(mwn);
			}
			return undefined;
		}
	}

	private async queryBotRight(mwn: Mwn): Promise<boolean> {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'query',
			meta: 'userinfo',
			uiprop: 'rights',
			formatversion: '2',
		})) as { query?: { userinfo?: { rights?: string[] } } };
		return response.query?.userinfo?.rights?.includes('bot') ?? false;
	}

	public async submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown> {
		const token = await mwn.getCsrfToken();
		const { tags } = this;
		const fullParams: Record<string, unknown> = { ...params, token, formatversion: '2' };
		if (tags !== null && tags !== undefined) {
			fullParams.tags = tags;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; we assemble fullParams to match the typed contract
		return mwn.request(fullParams as ApiParams);
	}

	public async submitUpload(
		mwn: Mwn,
		filepath: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		return this.upload(mwn, fileAt(filepath), title, text, params);
	}

	public async submitUploadFromBytes(
		mwn: Mwn,
		data: Buffer,
		filename: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		return this.upload(mwn, { stream: data, name: filename }, title, text, params);
	}

	private async upload(
		mwn: Mwn,
		file: FileField,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		const token = await mwn.getCsrfToken();
		const { tags } = this;
		const fullParams: Record<string, unknown> = {
			action: 'upload',
			file,
			filename: title,
			text,
			ignorewarnings: true,
			token,
			...params,
		};
		if (tags !== null && tags !== undefined) {
			fullParams.tags = tags;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn ApiParams shape; the multipart `file` field is mwn's documented upload form
		const response = (await mwn.request(fullParams as ApiParams, {
			headers: { 'Content-Type': 'multipart/form-data' },
		})) as { upload: ApiUploadResponse };
		return response.upload;
	}
}

/** mwn's multipart `file` field. */
interface FileField {
	readonly stream: Buffer | ReadStream;
	readonly name: string;
}

// mwn resends the same params when it retries a request, reading `stream` once
// per attempt, and a read stream is spent by the attempt that read it: a retry
// would declare the file's length and send none of it. So each read opens the
// file afresh, closing what a dropped attempt left half read.
function fileAt(filepath: string): FileField {
	let opened: ReadStream | undefined;
	return {
		get stream(): ReadStream {
			opened?.destroy();
			opened = createReadStream(filepath);
			return opened;
		},
		name: basename(filepath),
	};
}
