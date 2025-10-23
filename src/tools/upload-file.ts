import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiUploadParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiUploadResponse } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { formatEditComment } from '../common/utils.js';

export function uploadFileTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'upload-file',
		'Uploads a file to the wiki from the local disk.',
		{
			filepath: z.string().describe( 'File path on the local disk' ),
			title: z.string().describe( 'File title' ),
			text: z.string().describe( 'Wikitext on the file page' ),
			comment: z.string().describe( 'Reason for uploading the file' ).optional()
		},
		{
			title: 'Upload file',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ filepath, title, text, comment }
		) => handleUploadFileTool( filepath, title, text, comment )
	);
}

async function handleUploadFileTool(
	filepath: string, title: string, text: string, comment?: string
): Promise< CallToolResult > {

	let data: ApiUploadResponse;
	try {
		const mwn = await getMwn();
		data = await mwn.upload( filepath, title, text, getApiUploadParams( comment ) );
	} catch ( error ) {
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
		content: uploadFileToolResult( data )
	};
}

function getApiUploadParams( comment?: string ): ApiUploadParams {
	return {
		comment: formatEditComment( 'upload-file', comment )
	};
}

function uploadFileToolResult( data: ApiUploadResponse ): TextContent[] {
	const result: TextContent[] = [
		{
			type: 'text',
			text: 'File uploaded successfully'
		}
	];

	result.push( {
		type: 'text',
		text: `Upload details: ${ JSON.stringify( data, null, 2 ) }`
	} );

	return result;
}
