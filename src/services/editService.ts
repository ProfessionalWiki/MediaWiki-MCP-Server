import type { ApiParams, Mwn } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { ApiUploadResponse } from 'mwn';
import type { ActiveWiki } from '../wikis/activeWiki.js';

export interface EditService {
	/** Wraps mwn.request with CSRF + tag injection + formatversion=2. For action:edit and similar. */
	submit(mwn: Mwn, params: Record<string, unknown>): Promise<unknown>;

	/** Wraps mwn.upload with tag injection. CSRF is handled inside mwn.upload. */
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

	/** Pure helper: returns options with tags injected from the targeted wiki's config. Used by mwn.create/delete/undelete callers. */
	applyTags<T extends Record<string, unknown>>(options: T): T;

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
	public constructor(private readonly activeWiki: ActiveWiki) {}

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
		const tags = this.activeWiki.get().config.tags;
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
		const tags = this.activeWiki.get().config.tags;
		const fullParams: ApiUploadParams = { ...params };
		if (tags !== null && tags !== undefined) {
			fullParams.tags = tags;
		}
		return mwn.upload(filepath, title, text, fullParams);
	}

	public async submitUploadFromBytes(
		mwn: Mwn,
		data: Buffer,
		filename: string,
		title: string,
		text: string,
		params: ApiUploadParams,
	): Promise<ApiUploadResponse> {
		const token = await mwn.getCsrfToken();
		const tags = this.activeWiki.get().config.tags;
		// Pass the Buffer straight to mwn's multipart `file` field. form-data sizes
		// a Buffer directly; a Readable (e.g. Readable.from(buffer)) has no known
		// length and form-data rejects it with "Unknown stream".
		const fullParams: Record<string, unknown> = {
			action: 'upload',
			file: { stream: data, name: filename },
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

	public applyTags<T extends Record<string, unknown>>(options: T): T {
		const tags = this.activeWiki.get().config.tags;
		if (tags === null || tags === undefined) {
			return { ...options };
		}
		return { ...options, tags };
	}
}
