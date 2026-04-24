import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { getPageUrl, formatEditComment } from '../common/utils.js';

interface UpdatePageArgs {
	title: string;
	source: string;
	latestId?: number;
	comment?: string;
}

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Replaces the existing content of a wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. Pass latestId (obtained from get-page with metadata=true) to enable edit-conflict detection: if the page has been edited since that revision, the update is rejected rather than silently clobbering concurrent changes.',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Replacement page content in the existing page\'s content model' ),
			latestId: z.number().int().positive().optional().describe( 'Base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.' ),
			comment: z.string().optional().describe( 'Summary of the edit' )
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( args ) => handleUpdatePageTool( args as UpdatePageArgs )
	);
}

function errorResult( text: string ): CallToolResult {
	return {
		content: [ { type: 'text', text } as TextContent ],
		isError: true
	};
}

export async function handleUpdatePageTool(
	args: UpdatePageArgs
): Promise<CallToolResult> {
	const { title, source, latestId, comment } = args;

	try {
		const mwn = await getMwn();
		const token = await mwn.getCsrfToken();

		const params: Record<string, string | number | boolean | string[]> = {
			action: 'edit',
			title,
			text: source,
			summary: formatEditComment( 'update-page', comment ),
			nocreate: true,
			token,
			formatversion: '2'
		};
		if ( latestId !== undefined ) {
			params.baserevid = latestId;
		}

		const { config } = wikiService.getCurrent();
		if ( config.tags !== null && config.tags !== undefined ) {
			params.tags = config.tags;
		}

		const response = await mwn.request( params );
		const edit = response?.edit as ApiEditResponse | undefined;

		if ( !edit || edit.result !== 'Success' ) {
			return errorResult( `Failed to update page: ${ JSON.stringify( edit ?? response ) }` );
		}

		const resolvedTitle = edit.title ?? title;
		return {
			content: [
				{
					type: 'text',
					text: `Page updated successfully: ${ getPageUrl( resolvedTitle ) }`
				},
				{
					type: 'text',
					text: [
						'Page object:',
						`Page ID: ${ edit.pageid }`,
						`Title: ${ resolvedTitle }`,
						`Latest revision ID: ${ edit.newrevid }`,
						`Latest revision timestamp: ${ edit.newtimestamp }`,
						`Content model: ${ edit.contentmodel }`,
						`HTML URL: ${ getPageUrl( resolvedTitle ) }`
					].join( '\n' )
				}
			]
		};
	} catch ( error ) {
		return errorResult( `Failed to update page: ${ ( error as Error ).message }` );
	}
}
