import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { formatEditComment } from '../common/utils.js';

export function uploadFileFromUrlTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'upload-file-from-url',
		'Uploads a file to the wiki from a web URL.',
		{
			url: z.string().url().describe( 'URL of the file to upload' ),
			title: z.string().describe( 'File title' ),
			text: z.string().describe( 'Wikitext on the file page' ),
			comment: z.string().describe( 'Reason for uploading the file' ).optional()
		},
		{
			title: 'Upload file from URL',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ url, title, text, comment }
		) => handleUploadFileFromUrlTool( url, title, text, comment )
	);
}

async function handleUploadFileFromUrlTool(
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
			return {
				content: [
					{
						type: 'text',
						text: 'Upload failed: Upload by URL is disabled for this wiki. Please download the image from the URL to the local disk first, then use the upload-file tool to upload it from the local file path.'
					} as TextContent
				],
				isError: true
			};
		}

		return {
			content: [
				{
					type: 'text',
					text: `Upload failed: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}

	return {
		content: uploadFileFromUrlToolResult( data )
	};
}

function getApiUploadParams( comment?: string ): ApiUploadParams {
	return {
		comment: formatEditComment( 'upload-file-from-url', comment )
	};
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
