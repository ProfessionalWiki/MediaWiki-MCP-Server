import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { getCurrentWikiKey, setCurrentWiki } from '../common/config.js';
import { resolveWiki } from '../common/wikiDiscovery.js';
import { WikiDiscoveryError } from '../common/errors.js';

enum ContentFormat {
	noContent = 'noContent',
	withSource = 'withSource',
	withHtml = 'withHtml'
}

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Returns the standard page object for a wiki page, optionally including page source or rendered HTML, and including the license and information about the latest revision.',
		{
			title: z.string().describe( 'Wiki page title' ),
			content: z.nativeEnum( ContentFormat ).describe( 'Format of the page content to retrieve' ).optional().default( ContentFormat.noContent ),
			wikiUrl: z.string().url().describe( 'Optional URL of the wiki to use for this request.' ).optional()
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, content, wikiUrl } ) => handleGetPageTool( title, content, wikiUrl )
	);
}

async function handleGetPageTool( title: string, content: ContentFormat, wikiUrl?: string ): Promise<CallToolResult> {
	const originalWikiKey = getCurrentWikiKey();
	try {
		let subEndpoint: string;
		switch ( content ) {
			case ContentFormat.noContent:
				subEndpoint = '/bare';
				break;
			case ContentFormat.withSource:
				subEndpoint = '';
				break;
			case ContentFormat.withHtml:
				subEndpoint = '/with_html';
				break;
		}

		if ( wikiUrl ) {
			const wikiKey = await resolveWiki( wikiUrl );
			setCurrentWiki( wikiKey );
		}
		const data = await makeRestGetRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }${ subEndpoint }` );

		if ( data === null ) {
			return {
				content: [
					{ type: 'text', text: 'Failed to retrieve page data: No data returned from API' } as TextContent
				],
				isError: true
			};
		}

		return {
			content: getPageToolResult( data )
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
				{ type: 'text', text: `Failed to retrieve page data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	} finally {
		setCurrentWiki( originalWikiKey );
	}
}

function getPageToolResult( result: MwRestApiPageObject ): TextContent[] {
	const results: TextContent[] = [
		{
			type: 'text',
			text: [
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

	if ( result.source !== undefined ) {
		results.push( {
			type: 'text',
			text: `Source:\n${ result.source }`
		} );
	}

	if ( result.html !== undefined ) {
		results.push( {
			type: 'text',
			text: `HTML:\n${ result.html }`
		} );
	}

	return results;
}
