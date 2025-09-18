import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiFileObject } from '../types/mwRestApi.js';
import { getCurrentWikiKey, setCurrentWiki } from '../common/config.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

export function getFileTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-file',
		'Returns information about a file, including links to download the file in thumbnail, preview, and original formats.',
		{
			title: z.string().describe( 'File title' ),
			wikiUrl: z.string().url().describe( 'Optional URL of the wiki to use for this request.' ).optional()
		},
		{
			title: 'Get file',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, wikiUrl } ) => handleGetFileTool( title, wikiUrl )
	);
}

async function handleGetFileTool( title: string, wikiUrl?: string ): Promise< CallToolResult > {
	const originalWikiKey = getCurrentWikiKey();
	try {
		if ( wikiUrl ) {
			const wikiKey = await resolveWiki( wikiUrl );
			setCurrentWiki( wikiKey );
		}
		const data = await makeRestGetRequest<MwRestApiFileObject>( `/v1/file/${ encodeURIComponent( title ) }` );

		if ( data === null ) {
			return {
				content: [
					{ type: 'text', text: 'Failed to retrieve file data: No data returned from API' } as TextContent
				],
				isError: true
			};
		}

		return {
			content: getFileToolResult( data )
		};
	} catch ( error ) {
		if ( error instanceof WikiDiscoveryError ) {
			return {
				content: [ { type: 'text', text: error.message } as TextContent ],
				isError: true
			};
		}
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve file data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	} finally {
		setCurrentWiki( originalWikiKey );
	}
}

function getFileToolResult( result: MwRestApiFileObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: [
				`File title: ${ result.title }`,
				`File description URL: ${ result.file_description_url }`,
				`Latest revision timestamp: ${ result.latest.timestamp }`,
				`Latest revision user: ${ result.latest.user.name }`,
				`Preferred URL: ${ result.preferred.url }`,
				`Original URL: ${ result.original.url }`,
				`Thumbnail URL: ${ result.thumbnail?.url }`
			].join( '\n' )
		}
	];
}
