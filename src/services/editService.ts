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

	/** Pure helper: returns options with tags injected from the targeted wiki's config. Used by mwn.create/delete/undelete callers. */
	applyTags<T extends Record<string, unknown>>(options: T): T;
}

export class EditServiceImpl implements EditService {
	public constructor(private readonly activeWiki: ActiveWiki) {}

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

	public applyTags<T extends Record<string, unknown>>(options: T): T {
		const tags = this.activeWiki.get().config.tags;
		if (tags === null || tags === undefined) {
			return { ...options };
		}
		return { ...options, tags };
	}
}
