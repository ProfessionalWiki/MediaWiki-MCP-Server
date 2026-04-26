import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { assertAllowedPath, UploadValidationError } from '../common/uploadGuard.js';
import { formatEditComment, getPageUrl } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function uploadFileTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'upload-file',
		{
			description: 'Uploads a file from the local disk into the wiki\'s File namespace and returns the resulting file title and URL. The upload appears in the wiki\'s upload log. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if a file with the target title already exists (the wiki does not silently overwrite existing files). To upload directly from a remote web address instead of a local path, use upload-file-from-url. To replace an existing file with a new revision, use update-file.',
			inputSchema: {
				filepath: z.string().describe( 'File path on the local disk' ),
				title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
				text: z.string().describe( 'Wikitext on the file page' ),
				comment: z.string().optional().describe( 'Reason for uploading the file' )
			},
			annotations: {
				title: 'Upload file',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ filepath, title, text, comment }
		) => handleUploadFileTool( filepath, title, text, comment )
	);
}

export async function handleUploadFileTool(
	filepath: string, title: string, text: string, comment?: string
): Promise< CallToolResult > {

	let resolvedPath: string;
	try {
		resolvedPath = await assertAllowedPath( filepath, wikiService.getUploadDirs() );
	} catch ( error ) {
		if ( error instanceof UploadValidationError ) {
			return errorResult( 'invalid_input', `Failed to upload file: ${ error.message }` );
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to upload file: ${ ( error as Error ).message }`, code );
	}

	let data: ApiUploadResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.upload( resolvedPath, title, text, getApiUploadParams( comment ) );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to upload file: ${ ( error as Error ).message }`, code );
	}

	const imageinfo = ( data as ApiUploadResponse & {
		imageinfo?: { descriptionurl?: string; url?: string };
	} ).imageinfo;
	const filename = data.filename ?? title.replace( /^File:/, '' );
	return structuredResult( {
		filename,
		pageUrl: imageinfo?.descriptionurl ?? getPageUrl( `File:${ filename }` ),
		...( imageinfo?.url !== undefined ? { fileUrl: imageinfo.url } : {} )
	} );
}

function getApiUploadParams( comment?: string ): ApiUploadParams {
	const params: ApiUploadParams = {
		comment: formatEditComment( 'upload-file', comment )
	};
	const { config } = wikiService.getCurrent();
	if ( config.tags !== null && config.tags !== undefined ) {
		params.tags = config.tags;
	}
	return params;
}
