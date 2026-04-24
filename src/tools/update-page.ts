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
	section?: number | 'new';
	mode?: 'append' | 'prepend';
	sectionTitle?: string;
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
			source: z.string().describe( 'Replacement content in the existing page\'s content model. Interpreted as that section\'s content only when section is set.' ),
			latestId: z.number().int().positive().optional().describe( 'Base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.' ),
			comment: z.string().optional().describe( 'Summary of the edit' ),
			// eslint-disable-next-line es-x/no-set-prototype-union -- z.union, not Set.prototype.union
			section: z.union( [
				z.number().int().nonnegative(),
				z.literal( 'new' )
			] ).optional().describe( 'Section number to edit (0 = lead; 1..N = existing heading sections) or \'new\' to append a new heading section. When set, source is interpreted as that section\'s content only.' ),
			mode: z.enum( [ 'append', 'prepend' ] ).optional().describe( 'Treat source as a delta appended to the end (\'append\') or prepended to the start (\'prepend\') of the existing content, rather than replacing it. Each mode=append/prepend call is its own revision.' ),
			sectionTitle: z.string().optional().describe( 'Heading for a new section; required when section=\'new\', rejected otherwise.' )
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
	const { title, source, latestId, comment, section, mode, sectionTitle } = args;

	if ( section === 'new' && mode !== undefined ) {
		return errorResult( 'mode is not compatible with section=\'new\'' );
	}
	if ( section === 'new' && sectionTitle === undefined ) {
		return errorResult( 'sectionTitle is required when section=\'new\'' );
	}
	if ( sectionTitle !== undefined && section !== 'new' ) {
		return errorResult( 'sectionTitle is only valid when section=\'new\'' );
	}

	try {
		const mwn = await getMwn();
		const token = await mwn.getCsrfToken();

		const params: Record<string, string | number | boolean | string[]> = {
			action: 'edit',
			title,
			summary: formatEditComment( 'update-page', comment ),
			nocreate: true,
			token,
			formatversion: '2'
		};
		if ( mode === 'append' ) {
			params.appendtext = source;
		} else if ( mode === 'prepend' ) {
			params.prependtext = source;
		} else {
			params.text = source;
		}
		if ( latestId !== undefined ) {
			params.baserevid = latestId;
		}

		const { config } = wikiService.getCurrent();
		if ( config.tags !== null && config.tags !== undefined ) {
			params.tags = config.tags;
		}

		if ( section !== undefined ) {
			params.section = String( section );
		}
		if ( sectionTitle !== undefined ) {
			params.sectiontitle = sectionTitle;
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
		const msg = ( error as Error ).message;
		if ( /nosuchsection/i.test( msg ) ) {
			const label = section === undefined ? 'unknown' : String( section );
			return errorResult( `Section ${ label } does not exist` );
		}
		return errorResult( `Failed to update page: ${ msg }` );
	}
}
