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
		'Returns a wiki page.',
		{
			title: z.string().describe( 'Wiki page title' ),
			content: z.nativeEnum( ContentFormat ).describe( 'Type of content to return' ).optional().default( ContentFormat.source ),
			metadata: z.boolean().describe( 'Whether to include metadata (page ID, revision info, license) in the response' ).optional().default( false )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, content, metadata } ) => handleGetPageTool( title, content, metadata )
	);
}

async function handleGetPageTool(
	title: string, content: ContentFormat, metadata: boolean
): Promise<CallToolResult> {
	if ( content === ContentFormat.none && !metadata ) {
		return {
			content: [ {
				type: 'text',
				text: 'When content is set to "none", metadata must be true'
			} ],
			isError: true
		};
	}

	try {
		const data = await makeRestGetRequest<MwRestApiPageObject>(
			`/v1/page/${ encodeURIComponent( title ) }${ getSubEndpoint( content ) }`
		);
		return {
			content: getPageToolResult( data, content, metadata )
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

function getPageToolResult(
	result: MwRestApiPageObject, content: ContentFormat, metadata: boolean
): TextContent[] {
	if ( content === ContentFormat.source && !metadata ) {
		return [ {
			type: 'text',
			text: result.source ?? 'Not available'
		} ];
	}

	if ( content === ContentFormat.html && !metadata ) {
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
