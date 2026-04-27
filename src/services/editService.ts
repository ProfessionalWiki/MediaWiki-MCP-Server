import type { Mwn } from 'mwn';
/* eslint-disable n/no-missing-import */
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';

export interface EditService {
	/** Wraps mwn.request with CSRF + tag injection + formatversion=2. For action:edit and similar. */
	submit( mwn: Mwn, params: Record<string, unknown> ): Promise<unknown>;

	/** Wraps mwn.upload with tag injection. CSRF is handled inside mwn.upload. */
	submitUpload(
		mwn: Mwn,
		filepath: string,
		title: string,
		text: string,
		params: ApiUploadParams
	): Promise<ApiUploadResponse>;

	/** Pure helper: returns options with tags injected from the active wiki config. Used by mwn.create/delete/undelete callers. */
	applyTags<T extends Record<string, unknown>>( options: T ): T;
}
