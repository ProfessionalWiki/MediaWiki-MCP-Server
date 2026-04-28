import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { assertAllowedPath, UploadValidationError } from '../transport/uploadGuard.js';
import { formatEditComment, getPageUrl } from '../wikis/utils.js';

const inputSchema = {
	filepath: z.string().describe( 'File path on the local disk' ),
	title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
	text: z.string().describe( 'Wikitext on the file page' ),
	comment: z.string().optional().describe( 'Reason for uploading the file' )
} as const;

export const uploadFile: Tool<typeof inputSchema> = {
	name: 'upload-file',
	description: 'Uploads a file from the local disk into the wiki\'s File namespace and returns the resulting file title and URL. The upload appears in the wiki\'s upload log. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if a file with the target title already exists (the wiki does not silently overwrite existing files). To upload directly from a remote web address instead of a local path, use upload-file-from-url. To replace an existing file with a new revision, use update-file.',
	inputSchema,
	annotations: {
		title: 'Upload file',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'upload file',

	async handle(
		{ filepath, title, text, comment },
		ctx: ToolContext
	): Promise<CallToolResult> {
		let resolvedPath: string;
		try {
			resolvedPath = await assertAllowedPath( filepath, ctx.uploadDirs.list() );
		} catch ( error ) {
			if ( error instanceof UploadValidationError ) {
				return ctx.format.invalidInput( `Failed to upload file: ${ error.message }` );
			}
			throw error;
		}

		const mwn = await ctx.mwn();
		const params: ApiUploadParams = {
			comment: formatEditComment( 'upload-file', comment )
		};
		const data: ApiUploadResponse = await ctx.edit.submitUpload(
			mwn, resolvedPath, title, text, params
		);

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
