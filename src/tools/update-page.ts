import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiEditPageParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { getPageUrl, formatEditComment } from '../common/utils.js';

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Updates a wiki page. Replaces the existing content of a page with the provided content. Optionally pass latestId (from get-page with metadata=true) to enable edit-conflict detection.',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Page content in the same content model of the existing page' ),
			latestId: z.number().int().positive().optional().describe( 'Optional base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.' ),
			comment: z.string().optional().describe( 'Summary of the edit' )
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, source, latestId, comment }
		) => handleUpdatePageTool( title, source, latestId, comment )
	);
}

export async function handleUpdatePageTool(
	title: string,
	source: string,
	latestId?: number,
	comment?: string
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();
		// nocreate: fail if the page does not exist, so a mis-typed
		// title doesn't silently create a new page.
		const options: ApiEditPageParams = { nocreate: true };
		if ( latestId !== undefined ) {
			options.baserevid = latestId;
		}
		const { config } = wikiService.getCurrent();
		if ( config.tags !== undefined ) {
			options.tags = config.tags;
		}
		const result = await mwn.save(
			title, source,
			formatEditComment( 'update-page', comment ),
			options
		);

		return {
			content: [
				{
					type: 'text',
					text: `Page updated successfully: ${ getPageUrl( result.title ) }`
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
				{ type: 'text', text: `Failed to update page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
