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
import { assertFileExists, FileNotFoundError } from '../common/fileExistence.js';
import { formatEditComment, getPageUrl } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function updateFileTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'update-file',
		{
			description: 'Uploads a new revision of an existing file from the local disk, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki\'s upload log. Replaces the file content (bytes) only; for editing the wikitext on a file\'s description page, use update-page. The operator restricts which directories are readable; filepath must be an absolute path inside a configured upload directory, or the call fails before contacting the wiki. Fails if no file exists at the target title; for the initial upload, use upload-file. To upload a new revision from a remote web address instead of a local path, use update-file-from-url.',
			inputSchema: {
				filepath: z.string().describe( 'File path on the local disk' ),
				title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
				comment: z.string().optional().describe( 'Reason for uploading the new revision' )
			},
			annotations: {
				title: 'Update file',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ filepath, title, comment }
		) => handleUpdateFileTool( filepath, title, comment )
	);
}

export async function handleUpdateFileTool(
	filepath: string, title: string, comment?: string
): Promise< CallToolResult > {

	let resolvedPath: string;
	try {
		resolvedPath = await assertAllowedPath( filepath, wikiService.getUploadDirs() );
	} catch ( error ) {
		if ( error instanceof UploadValidationError ) {
			return errorResult( 'invalid_input', `Failed to update file: ${ error.message }` );
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to update file: ${ ( error as Error ).message }`, code );
	}

	try {
		await assertFileExists( title );
	} catch ( error ) {
		if ( error instanceof FileNotFoundError ) {
			return errorResult(
				'not_found',
				`File "${ error.title }" does not exist. To create a new file, use upload-file.`
			);
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to update file: ${ ( error as Error ).message }`, code );
	}

	let data: ApiUploadResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.upload( resolvedPath, title, '', getApiUploadParams( comment ) );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to update file: ${ ( error as Error ).message }`, code );
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
		comment: formatEditComment( 'update-file', comment ),
		ignorewarnings: true
	};
	const { config } = wikiService.getCurrent();
	if ( config.tags !== null && config.tags !== undefined ) {
		params.tags = config.tags;
	}
	return params;
}
