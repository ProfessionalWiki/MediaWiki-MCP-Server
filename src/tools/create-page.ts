import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { getPageUrl, formatEditComment } from '../common/utils.js';

export function createPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'create-page',
		'Creates a wiki page with the provided content.',
		{
			source: z.string().describe( 'Page content in the format specified by the contentModel parameter' ),
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().optional().describe( 'Reason for creating the page' ),
			contentModel: z.string().optional().default( 'wikitext' ).describe( 'Type of content on the page' )
		},
		{
			title: 'Create page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ source, title, comment, contentModel }
		) => handleCreatePageTool( source, title, comment, contentModel )
	);
}

export async function handleCreatePageTool(
	source: string,
	title: string,
	comment?: string,
	contentModel?: string
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();
		const result = await mwn.create(
			title, source,
			formatEditComment( 'create-page', comment ),
			// eslint-disable-next-line @typescript-eslint/no-explicit-any
			{ contentmodel: contentModel as any }
		);

		return {
			content: [
				{
					type: 'text',
					text: `Page created successfully: ${ getPageUrl( result.title ) }`
				},
				{
					type: 'text',
					text: [
						'Page object:',
						`Page ID: ${ result.pageid }`,
						`Title: ${ result.title }`,
						`Latest revision ID: ${ result.newrevid }`,
						`Latest revision timestamp: ${ result.newtimestamp }`,
						`Content model: ${ result.contentmodel }`,
						`HTML URL: ${ getPageUrl( result.title ) }`
					].join( '\n' )
				}
			]
		};
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to create page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
