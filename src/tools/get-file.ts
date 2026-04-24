import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ImageInfo } from 'mwn';
import { classifyError, errorResult } from '../common/errorMapping.js';

export function getFileTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-file',
		'Returns metadata for a file (uploader, timestamp, size, MIME type) along with download URLs for the thumbnail, preview, and original. The File: prefix is added automatically if omitted.',
		{
			title: z.string().describe( 'File title (with or without the "File:" prefix)' )
		},
		{
			title: 'Get file',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( { title } ) => handleGetFileTool( title )
	);
}

export async function handleGetFileTool( title: string ): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();

		const fileTitle = title.startsWith( 'File:' ) ? title : `File:${ title }`;

		const response = await mwn.request( {
			action: 'query',
			titles: fileTitle,
			prop: 'imageinfo',
			iiprop: 'url|size|mime|timestamp|user',
			iiurlwidth: 200,
			formatversion: '2'
		} );

		const page = response.query?.pages?.[ 0 ] as ApiPage | undefined;

		if ( !page || page.missing ) {
			return errorResult( 'not_found', `File "${ title }" not found` );
		}

		const info: ImageInfo | undefined = page.imageinfo?.[ 0 ];

		if ( !info ) {
			return errorResult( 'not_found', `No file info available for "${ title }"` );
		}

		return {
			content: [
				{
					type: 'text',
					text: [
						`File title: ${ page.title }`,
						`File description URL: ${ info.descriptionurl }`,
						`Timestamp: ${ info.timestamp }`,
						`User: ${ info.user }`,
						`Size: ${ info.size } bytes`,
						`MIME type: ${ info.mime }`,
						`Original URL: ${ info.url }`,
						`Thumbnail URL: ${
							( info as ImageInfo & { thumburl?: string } ).thumburl ??
							'Not available'
						}`
					].join( '\n' )
				}
			]
		};
	} catch ( error ) {
		const { category } = classifyError( error );
		return errorResult( category, `Failed to retrieve file data: ${ ( error as Error ).message }` );
	}
}
