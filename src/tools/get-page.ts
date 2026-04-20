import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { getPageUrl } from '../common/utils.js';
import { ContentFormat } from '../common/contentFormat.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Returns a wiki page. Use metadata=true to retrieve the revision ID required by update-page. Set content="none" to fetch only metadata without content.',
		{
			title: z.string().describe( 'Wiki page title' ),
			content: z.nativeEnum( ContentFormat ).optional().default( ContentFormat.source ).describe( 'Type of content to return' ),
			metadata: z.boolean().optional().default( false ).describe( 'Whether to include metadata (page ID, revision info) in the response' )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { title, content, metadata } ) => handleGetPageTool( title, content, metadata )
	);
}

function buildPageMetadata(
	page: { pageid: number; title: string },
	rev?: { revid?: number; timestamp?: string; contentmodel?: string }
): TextContent {
	return {
		type: 'text',
		text: [
			`Page ID: ${ page.pageid }`,
			`Title: ${ page.title }`,
			`Latest revision ID: ${ rev?.revid }`,
			`Latest revision timestamp: ${ rev?.timestamp }`,
			`Content model: ${ rev?.contentmodel }`,
			`HTML URL: ${ getPageUrl( page.title ) }`
		].join( '\n' )
	};
}

export async function handleGetPageTool(
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
		const mwn = await getMwn();
		const results: TextContent[] = [];

		const needsReadCall = metadata ||
			content === ContentFormat.source ||
			content === ContentFormat.none;
		const needsSource = content === ContentFormat.source;

		if ( needsReadCall ) {
			const rvprop = needsSource ?
				'ids|timestamp|contentmodel|content' :
				'ids|timestamp|contentmodel';
			const page = await mwn.read( title, { rvprop } );

			if ( page.missing ) {
				return {
					content: [ {
						type: 'text',
						text: `Page "${ title }" not found`
					} as TextContent ],
					isError: true
				};
			}

			const rev = page.revisions?.[ 0 ];

			if ( metadata || content === ContentFormat.none ) {
				results.push( buildPageMetadata( page, rev ) );
			}

			if ( needsSource && rev?.content !== undefined ) {
				results.push( {
					type: 'text',
					text: metadata ?
						`Source:\n${ rev.content }` : rev.content
				} );
			}
		}

		if ( content === ContentFormat.html ) {
			if ( metadata && results.length === 0 ) {
				const page = await mwn.read( title, {
					rvprop: 'ids|timestamp|contentmodel'
				} );
				if ( page.missing ) {
					return {
						content: [ {
							type: 'text',
							text: `Page "${ title }" not found`
						} as TextContent ],
						isError: true
					};
				}
				results.push(
					buildPageMetadata( page, page.revisions?.[ 0 ] )
				);
			}

			const parseResult = await mwn.request( {
				action: 'parse',
				page: title,
				prop: 'text',
				formatversion: '2'
			} );
			const html = parseResult.parse?.text;

			results.push( {
				type: 'text',
				text: metadata ?
					`HTML:\n${ html }` : ( html ?? 'Not available' )
			} );
		}

		return { content: results };
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Failed to retrieve page data: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}
}
