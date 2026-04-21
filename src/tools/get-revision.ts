import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ApiRevision } from 'mwn';
import { getPageUrl } from '../common/utils.js';
import { ContentFormat } from '../common/contentFormat.js';

export function getRevisionTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-revision',
		'Returns a specific historical revision of a wiki page by revision ID (wikitext source, rendered HTML, or metadata only). If the revision ID does not exist, an error is returned. For the latest revision plus metadata, use get-page with metadata=true.',
		{
			revisionId: z.number().int().positive().describe( 'Revision ID' ),
			content: z.nativeEnum( ContentFormat ).describe( 'Type of content to return' ).optional().default( ContentFormat.source ),
			metadata: z.boolean().describe( 'Whether to include metadata (revision ID, page ID, page title, user ID, user name, timestamp, comment, size, minor, HTML URL) in the response' ).optional().default( false )
		},
		{
			title: 'Get revision',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async (
			{ revisionId, content, metadata }
		) => handleGetRevisionTool( revisionId, content, metadata )
	);
}

function buildRevisionMetadata(
	page: ApiPage, rev: ApiRevision
): TextContent {
	return {
		type: 'text',
		text: [
			`Revision ID: ${ rev.revid }`,
			`Page ID: ${ page.pageid }`,
			`Title: ${ page.title }`,
			`User ID: ${ rev.userid }`,
			`User Name: ${ rev.user }`,
			`Timestamp: ${ rev.timestamp }`,
			`Comment: ${ rev.comment }`,
			`Size: ${ rev.size }`,
			`Minor: ${ rev.minor ?? false }`,
			`HTML URL: ${ getPageUrl( page.title ) }`
		].join( '\n' )
	};
}

export async function handleGetRevisionTool(
	revisionId: number, content: ContentFormat, metadata: boolean
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

		const needsSource = content === ContentFormat.source;
		const needsMetadata = metadata || content === ContentFormat.none;

		if ( needsSource || needsMetadata ) {
			const rvprop = needsSource ?
				'ids|timestamp|user|userid|comment|size|flags|content' :
				'ids|timestamp|user|userid|comment|size|flags';

			const response = await mwn.request( {
				action: 'query',
				prop: 'revisions',
				revids: revisionId,
				rvprop,
				formatversion: '2'
			} );

			const page = response.query?.pages?.[ 0 ] as ApiPage | undefined;
			const rev: ApiRevision | undefined = page?.revisions?.[ 0 ];

			if ( !rev || !page ) {
				return {
					content: [ {
						type: 'text',
						text: `Revision ${ revisionId } not found`
					} as TextContent ],
					isError: true
				};
			}

			if ( needsMetadata ) {
				results.push( buildRevisionMetadata( page, rev ) );
			}

			if ( needsSource && rev.content !== undefined ) {
				results.push( {
					type: 'text',
					text: metadata ?
						`Source:\n${ rev.content }` : rev.content
				} );
			}
		}

		if ( content === ContentFormat.html ) {
			const parseResult = await mwn.request( {
				action: 'parse',
				oldid: revisionId,
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
					text: `Failed to retrieve revision data: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}
}
