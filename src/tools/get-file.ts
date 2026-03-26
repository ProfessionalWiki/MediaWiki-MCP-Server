import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ImageInfo } from 'mwn';

export function getFileTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-file',
		'Returns information about a file, including links to download the file in thumbnail, preview, and original formats.',
		{
			title: z.string().describe( 'File title' )
		},
		{
			title: 'Get file',
			readOnlyHint: true,
			destructiveHint: false
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
			return {
				content: [
					{ type: 'text', text: `File "${ title }" not found` } as TextContent
				],
				isError: true
			};
		}

		const info: ImageInfo | undefined = page.imageinfo?.[ 0 ];

		if ( !info ) {
			return {
				content: [
					{ type: 'text', text: `No file info available for "${ title }"` } as TextContent
				],
				isError: true
			};
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
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve file data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
