import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiRevisionObject } from '../types/mwRestApi.js';
import { ContentFormat, getSubEndpoint } from '../common/mwRestApiContentFormat.js';

export function getRevisionTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-revision',
		'Returns a revision of a wiki page. **Use `source` for source text (e.g. wikitext) or `html` for HTML to get just the page content.** Use `sourceAndMetadata` or `htmlAndMetadata` only when you need metadata (page ID, revision info, license).',
		{
			revisionId: z.number().describe( 'Revision ID' ),
			content: z.nativeEnum( ContentFormat ).describe( 'Format: `source` (source text only) or `html` (HTML only) for content without metadata. Use `sourceAndMetadata`/`htmlAndMetadata` only if metadata needed. Use `metadata` for metadata only.' ).optional().default( ContentFormat.source )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { revisionId, content } ) => handleGetRevisionTool( revisionId, content )
	);
}

async function handleGetRevisionTool(
	revisionId: number, content: ContentFormat
): Promise<CallToolResult> {
	try {
		const data = await makeRestGetRequest<MwRestApiRevisionObject>(
			`/v1/revision/${ revisionId }${ getSubEndpoint( content ) }`
		);
		return {
			content: getRevisionToolResult( data, content )
		};
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve revision data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}

function getRevisionToolResult(
	result: MwRestApiRevisionObject,
	content: ContentFormat
): TextContent[] {
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

	const results: TextContent[] = [ getRevisionMetadataTextContent( result ) ];

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

function getRevisionMetadataTextContent( result: MwRestApiRevisionObject ): TextContent {
	return {
		type: 'text',
		text: [
			`Revision ID: ${ result.id }`,
			`Page ID: ${ result.page?.id }`,
			`Page Title: ${ result.page?.title }`,
			`User ID: ${ result.user.id }`,
			`User Name: ${ result.user.name }`,
			`Timestamp: ${ result.timestamp }`,
			`Comment: ${ result.comment }`,
			`Size: ${ result.size }`,
			`Delta: ${ result.delta }`,
			`Minor: ${ result.minor }`,
			`HTML URL: ${ result.html_url ?? 'Not available' }`
		].join( '\n' )
	};
}
