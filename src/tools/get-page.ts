import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';

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
			content: z.nativeEnum( ContentFormat ).describe( 'Format of the page content to retrieve' )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, content } ) => handleGetPageTool( title, content )
	);
}

async function handleGetPageTool( title: string, content: ContentFormat ): Promise<CallToolResult> {
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

	const data = await makeRestGetRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }${ subEndpoint }` );

	if ( !data ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to retrieve page data' } as TextContent
			],
			isError: true
		};
	}

	return {
		content: getPageToolResult( data )
	};
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
