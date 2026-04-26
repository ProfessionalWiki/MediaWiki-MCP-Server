import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { assertFileExists, FileNotFoundError } from '../common/fileExistence.js';
import { formatEditComment, getPageUrl } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function updateFileFromUrlTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'update-file-from-url',
		{
			description: 'Fetches a file from a remote web URL and uploads it as a new revision of an existing file, preserving prior revisions in the file history, and returns the file title and URL. The upload appears in the wiki\'s upload log. Replaces the file content (bytes) only; for editing the wikitext on a file\'s description page, use update-page. Requires the wiki to have upload-by-URL enabled; if it is disabled, download the file locally and use update-file instead. Fails if no file exists at the target title; for the initial upload, use upload-file-from-url.',
			inputSchema: {
				url: z.string().url().describe( 'URL of the file to upload' ),
				title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
				comment: z.string().optional().describe( 'Reason for uploading the new revision' )
			},
			annotations: {
				title: 'Update file from URL',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: false,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ url, title, comment }
		) => handleUpdateFileFromUrlTool( url, title, comment )
	);
}

export async function handleUpdateFileFromUrlTool(
	url: string, title: string, comment?: string
): Promise< CallToolResult > {

	try {
		await assertFileExists( title );
	} catch ( error ) {
		if ( error instanceof FileNotFoundError ) {
			return errorResult(
				'not_found',
				`File "${ error.title }" does not exist. To create a new file, use upload-file-from-url.`
			);
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to update file: ${ ( error as Error ).message }`, code );
	}

	let data: ApiUploadResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.uploadFromUrl( url, title, '', getApiUploadParams( comment ) );
	} catch ( error ) {
		const errorMessage = ( error as Error ).message;

		// Mirror upload-file-from-url: redirect the model away from retrying via URL when
		// the wiki has copyuploads disabled. Routing hint points at the update-file (local)
		// sibling for this tool's update intent.
		if ( errorMessage.includes( 'copyuploaddisabled' ) ) {
			return errorResult(
				'invalid_input',
				'Upload by URL is disabled on this wiki. Download the file locally, then use update-file with the local file path.',
				'copyuploaddisabled'
			);
		}

		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to update file: ${ errorMessage }`, code );
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
		comment: formatEditComment( 'update-file-from-url', comment ),
		ignorewarnings: true
	};
	const { config } = wikiService.getCurrent();
	if ( config.tags !== null && config.tags !== undefined ) {
		params.tags = config.tags;
	}
	return params;
}
