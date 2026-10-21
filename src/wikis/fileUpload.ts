import type { ApiUploadResponse, Mwn } from 'mwn';
import type { ApiUploadParams } from 'types-mediawiki-api';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from '../runtime/context.ts';
import { errorMessage } from '../errors/errorMessage.ts';
import { fetchFileBytes, shouldRescueToWiki } from '../transport/httpFetch.ts';
import { buildPageUrl } from './utils.ts';

export interface UrlUpload {
	url: string;
	title: string;
	text: string;
	params: ApiUploadParams;
}

export async function uploadedFile(
	ctx: ToolContext,
	data: ApiUploadResponse,
	title: string,
): Promise<CallToolResult> {
	const imageinfo = (
		data as ApiUploadResponse & {
			imageinfo?: { descriptionurl?: string; url?: string };
		}
	).imageinfo;
	const filename = data.filename ?? title.replace(/^File:/, '');
	return ctx.format.ok({
		filename,
		pageUrl: imageinfo?.descriptionurl ?? (await buildPageUrl(ctx, `File:${filename}`)),
		...(imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {}),
	});
}

// Server-first: fetch the bytes ourselves (SSRF-guarded, size-capped) and upload
// them as a normal multipart request, so the wiki needs no copy-upload config or
// upload_by_url right. Only a URL the server cannot reach, or a file over its
// size cap, is left for the wiki to fetch.
export async function uploadFromUrl(
	ctx: ToolContext,
	mwn: Mwn,
	{ url, title, text, params }: UrlUpload,
): Promise<CallToolResult> {
	let bytes: Buffer | undefined;
	try {
		bytes = await fetchFileBytes(url);
	} catch (error) {
		if (!shouldRescueToWiki(error)) {
			throw error;
		}
	}

	if (bytes !== undefined) {
		const partName = title.replace(/^File:/, '');
		const data = await ctx.edit.submitUploadFromBytes(mwn, bytes, partName, title, text, params);
		return uploadedFile(ctx, data, title);
	}

	let response: { upload: ApiUploadResponse };
	try {
		response = (await ctx.edit.submit(mwn, {
			action: 'upload',
			url,
			filename: title,
			text,
			ignorewarnings: true,
			...params,
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=upload response shape; trusted at this boundary
		})) as { upload: ApiUploadResponse };
	} catch (error) {
		if (errorMessage(error).includes('copyuploaddisabled')) {
			return ctx.format.error(
				'upstream_failure',
				`Could not retrieve the file from ${url}: the server could not reach it and the wiki has upload-by-URL disabled.`,
				'copyuploaddisabled',
			);
		}
		throw error;
	}
	return uploadedFile(ctx, response.upload, title);
}
