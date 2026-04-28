import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { formatEditComment, getPageUrl } from '../wikis/utils.js';

const inputSchema = {
	url: z.string().url().describe( 'URL of the file to upload' ),
	title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
	text: z.string().describe( 'Wikitext on the file page' ),
	comment: z.string().optional().describe( 'Reason for uploading the file' )
} as const;

export const uploadFileFromUrl: Tool<typeof inputSchema> = {
	name: 'upload-file-from-url',
	description: 'Fetches a file from a remote web URL and uploads it into the wiki\'s File namespace, returning the resulting file title and URL. The upload appears in the wiki\'s upload log. Requires the wiki to have upload-by-URL enabled; if it is disabled, download the file locally and use upload-file instead. Fails if a file with the target title already exists. To replace an existing file with a new revision, use update-file-from-url.',
	inputSchema,
	annotations: {
		title: 'Upload file from URL',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'upload file',

	async handle(
		{ url, title, text, comment },
		ctx: ToolContext
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const baseParams: ApiUploadParams = {
			comment: formatEditComment( 'upload-file-from-url', comment )
		};
		const params = ctx.edit.applyTags<ApiUploadParams>( baseParams );

		let data: ApiUploadResponse;
		try {
			data = await mwn.uploadFromUrl( url, title, text, params );
		} catch ( error ) {
			const errorMessage = ( error as Error ).message;
			// Prevent the LLM from attempting to find an existing image on the wiki
			// after failing to upload by URL.
			if ( errorMessage.includes( 'copyuploaddisabled' ) ) {
				return ctx.format.error(
					'invalid_input',
					'Upload by URL is disabled on this wiki. Download the file locally, then use upload-file with the local file path.',
					'copyuploaddisabled'
				);
			}
			throw error;
		}

		const imageinfo = ( data as ApiUploadResponse & {
			imageinfo?: { descriptionurl?: string; url?: string };
		} ).imageinfo;
		const filename = data.filename ?? title.replace( /^File:/, '' );
		return ctx.format.ok( {
			filename,
			pageUrl: imageinfo?.descriptionurl ?? getPageUrl( `File:${ filename }` ),
			...( imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {} )
		} );
	}
};
