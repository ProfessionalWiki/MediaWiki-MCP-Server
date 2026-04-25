import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { formatEditComment, getPageUrl } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function uploadFileFromUrlTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'upload-file-from-url',
		{
			description: 'Fetches a file from a remote web URL and uploads it into the wiki\'s File namespace, returning the resulting file title and URL. Requires the wiki to have upload-by-URL enabled; if it is disabled, download the file locally and use upload-file instead. Fails if a file with the target title already exists.',
			inputSchema: {
				url: z.string().url().describe( 'URL of the file to upload' ),
				title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
				text: z.string().describe( 'Wikitext on the file page' ),
				comment: z.string().optional().describe( 'Reason for uploading the file' )
			},
			annotations: {
				title: 'Upload file from URL',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ url, title, text, comment }
		) => handleUploadFileFromUrlTool( url, title, text, comment )
	);
}

export async function handleUploadFileFromUrlTool(
	url: string, title: string, text: string, comment?: string
): Promise< CallToolResult > {

	let data: ApiUploadResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.uploadFromUrl( url, title, text, getApiUploadParams( comment ) );
	} catch ( error ) {
		const errorMessage = ( error as Error ).message;

		// Prevent the LLM from attempting to find an existing image on the wiki
		// after failing to upload by URL.
		if ( errorMessage.includes( 'copyuploaddisabled' ) ) {
			return errorResult(
				'invalid_input',
				'Upload by URL is disabled on this wiki. Download the file locally, then use upload-file with the local file path.',
				'copyuploaddisabled'
			);
		}

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
		comment: formatEditComment( 'upload-file-from-url', comment )
	};
	const { config } = wikiService.getCurrent();
	if ( config.tags !== null && config.tags !== undefined ) {
		params.tags = config.tags;
	}
	return params;
}
