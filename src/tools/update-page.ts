import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPutRequest, getPageUrl, formatEditComment } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { getCurrentWikiKey, setCurrentWiki } from '../common/config.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Updates a wiki page. Replaces the existing content of a page with the provided content',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Page content in the same content model of the existing page' ),
			latestId: z.number().describe( 'Identifier for the revision used as the base for the new source' ),
			comment: z.string().describe( 'Summary of the edit' ).optional(),
			wikiUrl: z.string().url().describe( 'Optional URL of the wiki to use for this request.' ).optional()
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, source, latestId, comment, wikiUrl }
		) => handleUpdatePageTool( title, source, latestId, comment, wikiUrl )
	);
}

async function handleUpdatePageTool(
	title: string,
	source: string,
	latestId: number,
	comment?: string,
	wikiUrl?: string
): Promise<CallToolResult> {
	const originalWikiKey = getCurrentWikiKey();
	try {
		if ( wikiUrl ) {
			const wikiKey = await resolveWiki( wikiUrl );
			setCurrentWiki( wikiKey );
		}
		const data = await makeRestPutRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }`, {
			source: source,
			comment: formatEditComment( 'update-page', comment ),
			latest: { id: latestId }
		}, true );

		if ( data === null ) {
			return {
				content: [
					{ type: 'text', text: 'Failed to update page: No data returned from API' } as TextContent
				],
				isError: true
			};
		}

		return {
			content: updatePageToolResult( data )
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
				{ type: 'text', text: `Failed to update page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	} finally {
		setCurrentWiki( originalWikiKey );
	}
}

function updatePageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page updated successfully: ${ getPageUrl( result.title ) }`
		},
		{
			type: 'text',
			text: [
				'Page object:',
				`Page ID: ${ result.id }`,
				`Title: ${ result.title }`,
				`Latest revision ID: ${ result.latest.id }`,
				`Latest revision timestamp: ${ result.latest.timestamp }`,
				`Content model: ${ result.content_model }`,
				`License: ${ result.license.url } ${ result.license.title }`,
				`HTML URL: ${ result.html_url }`
			].join( '\n' )
		}
	];
}
