import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPostRequest, getPageUrl, formatEditComment } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { getCurrentWikiKey, setCurrentWiki } from '../common/config.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

export function createPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'create-page',
		'Creates a wiki page with the provided content.',
		{
			source: z.string().describe( 'Page content in the format specified by the contentModel parameter' ),
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().describe( 'Reason for creating the page' ).optional(),
			contentModel: z.string().describe( 'Type of content on the page. Defaults to "wikitext"' ).optional(),
			wikiUrl: z.string().url().describe( 'Optional URL of the wiki to use for this request.' ).optional()
		},
		{
			title: 'Create page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ source, title, comment, contentModel, wikiUrl }
		) => handleCreatePageTool( source, title, comment, contentModel, wikiUrl )
	);
}

async function handleCreatePageTool(
	source: string,
	title: string,
	comment?: string,
	contentModel?: string,
	wikiUrl?: string
): Promise<CallToolResult> {
	const originalWikiKey = getCurrentWikiKey();
	try {
		if ( wikiUrl ) {
			const wikiKey = await resolveWiki( wikiUrl );
			setCurrentWiki( wikiKey );
		}

		const data = await makeRestPostRequest<MwRestApiPageObject>( '/v1/page', {
			source: source,
			title: title,
			comment: formatEditComment( 'create-page', comment ),
			// eslint-disable-next-line camelcase
			content_model: contentModel
		}, true );

		if ( data === null ) {
			return {
				content: [
					{ type: 'text', text: 'Failed to create page: No data returned from API' } as TextContent
				],
				isError: true
			};
		}

		return {
			content: createPageToolResult( data )
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
				{ type: 'text', text: `Failed to create page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	} finally {
		setCurrentWiki( originalWikiKey );
	}
}

function createPageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page created successfully: ${ getPageUrl( result.title ) }`
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
