import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { formatEditComment } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';

export function uploadFileFromUrlTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'upload-file-from-url',
		'Fetches a file from a remote web URL and uploads it into the wiki\'s File namespace, returning the resulting file title and URL. Requires the wiki to have upload-by-URL enabled; if it is disabled, download the file locally and use upload-file instead. Fails if a file with the target title already exists.',
		{
			url: z.string().url().describe( 'URL of the file to upload' ),
			title: z.string().describe( 'File title (with or without the "File:" prefix)' ),
			text: z.string().describe( 'Wikitext on the file page' ),
			comment: z.string().optional().describe( 'Reason for uploading the file' )
		},
		{
			title: 'Upload file from URL',
			readOnlyHint: false,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
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
				'Upload by URL is disabled on this wiki. Download the file locally, then use upload-file with the local file path.'
			);
		}

		const { category } = classifyError( error );
		return errorResult( category, `Failed to upload file: ${ ( error as Error ).message }` );
	}

	return {
		content: uploadFileFromUrlToolResult( data )
	};
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

function uploadFileFromUrlToolResult( data: ApiUploadResponse ): TextContent[] {
	const result: TextContent[] = [
		{
			type: 'text',
			text: 'File uploaded successfully from URL'
		}
	];

	result.push( {
		type: 'text',
		text: `Upload details: ${ JSON.stringify( data, null, 2 ) }`
	} );

	return result;
}
