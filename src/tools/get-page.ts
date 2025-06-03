import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestGetRequest } from '../common/utils.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';
import { stripHtml } from 'string-strip-html';

enum ContentFormat {
	noContent = 'noContent',
	withSource = 'withSource',
	withHtml = 'withHtml',
	withPlainText = 'withPlainText'
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

async function handleGetPageTool( title: string, contentFormat: ContentFormat ): Promise<CallToolResult> {
	let subEndpoint: string;
	switch ( contentFormat ) {
		case ContentFormat.noContent:
			subEndpoint = '/bare';
			break;
		case ContentFormat.withSource:
			subEndpoint = '';
			break;
		case ContentFormat.withHtml:
		case ContentFormat.withPlainText:
			subEndpoint = '/with_html';
			break;
	}

	let data: MwRestApiPageObject | null = null;

	try {
		data = await makeRestGetRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }${ subEndpoint }` );
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve page data: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	if ( data === null ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to retrieve page data: No data returned from API' } as TextContent
			],
			isError: true
		};
	}

	return {
		content: getPageToolResult( data, contentFormat )
	};
}

function getPageToolResult( result: MwRestApiPageObject, contentFormat: ContentFormat ): TextContent[] {
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
		if ( contentFormat === ContentFormat.withHtml ) {
			results.push( {
				type: 'text',
				text: `HTML:\n${ result.html }`
			} );
		} else if ( contentFormat === ContentFormat.withPlainText ) {
			results.push( {
				type: 'text',
				text: `Text:\n${ stripHtml( result.html ).result }`
			} );
		}
	}

	return results;
}
