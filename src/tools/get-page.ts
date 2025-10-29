import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { ContentFormat, getSubEndpoint } from '../common/mwRestApiContentFormat.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Returns a wiki page. **Use `source` for source text (e.g. wikitext) or `html` for HTML to get just the page content.** Use `sourceAndMetadata` or `htmlAndMetadata` only when you need metadata (page ID, revision info, license).',
		{
			title: z.string().describe( 'Wiki page title' ),
			content: z.nativeEnum( ContentFormat ).describe( 'Format: `source` (source text only) or `html` (HTML only) for content without metadata. Use `sourceAndMetadata`/`htmlAndMetadata` only if metadata needed. Use `metadata` for metadata only.' ).optional().default( ContentFormat.source )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, content } ) => handleGetPageTool( { title, content } )
	);
}

async function handleGetPageTool(
	params: { title: string; content: ContentFormat }
): Promise<CallToolResult> {
	try {
		const data = await makeRestGetRequest<MwRestApiPageObject>(
			`/v1/page/${ encodeURIComponent( params.title ) }${ getSubEndpoint( params.content ) }`
		);
		return {
			content: getPageToolResult( data, params.content )
		};
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve page data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}

function getPageToolResult( result: MwRestApiPageObject, content: ContentFormat ): TextContent[] {
	if ( content === ContentFormat.source ) {
		return [ {
			type: 'text',
			text: result.source ?? 'Not available'
		} ];
	}

	if ( content === ContentFormat.html ) {
		return [ {
			type: 'text',
			text: result.html ?? 'Not available'
		} ];
	}

	const results: TextContent[] = [ getPageMetadataTextContent( result ) ];

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

function getPageMetadataTextContent( result: MwRestApiPageObject ): TextContent {
	return {
		type: 'text',
		text: [
			`Page ID: ${ result.id }`,
			`Title: ${ result.title }`,
			`Latest revision ID: ${ result.latest.id }`,
			`Latest revision timestamp: ${ result.latest.timestamp }`,
			`Content model: ${ result.content_model }`,
			`License: ${ result.license.url } ${ result.license.title }`,
			`HTML URL: ${ result.html_url ?? 'Not available' }`
		].join( '\n' )
	};
}
