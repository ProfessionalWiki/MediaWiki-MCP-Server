import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ApiRevision } from 'mwn';
import { instrumentToolCall } from './instrument.js';
import { getPageUrl } from '../common/utils.js';
import { ContentFormat } from '../common/contentFormat.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function getRevisionTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'get-revision',
		{
			description: 'Returns a specific historical revision of a wiki page by revision ID (wikitext source, rendered HTML, or metadata only). If the revision ID does not exist, an error is returned. For the latest revision plus metadata, use get-page with metadata=true.',
			inputSchema: {
				revisionId: z.number().int().positive().describe( 'Revision ID' ),
				content: z.nativeEnum( ContentFormat ).describe( 'Type of content to return' ).optional().default( ContentFormat.source ),
				metadata: z.boolean().describe( 'Whether to include metadata (revision ID, page ID, page title, user ID, user name, timestamp, comment, size, minor, HTML URL) in the response' ).optional().default( false )
			},
			annotations: {
				title: 'Get revision',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		instrumentToolCall(
			'get-revision',
			async ( { revisionId, content, metadata } ) => (
				handleGetRevisionTool( revisionId, content, metadata )
			),
			( a ) => String( a.revisionId )
		)
	);
}

export async function handleGetRevisionTool(
	revisionId: number, content: ContentFormat, metadata: boolean
): Promise<CallToolResult> {
	if ( content === ContentFormat.none && !metadata ) {
		return errorResult( 'invalid_input', 'When content is set to "none", metadata must be true' );
	}

	try {
		const mwn = await getMwn();
		const payload: {
			revisionId?: number;
			pageId?: number;
			title?: string;
			url?: string;
			userid?: number;
			user?: string;
			timestamp?: string;
			comment?: string;
			size?: number;
			minor?: boolean;
			contentModel?: string;
			source?: string;
			html?: string;
		} = {};

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

			if ( !rev || !page || page.missing ) {
				return errorResult( 'not_found', `Revision ${ revisionId } not found` );
			}

			payload.revisionId = rev.revid;
			payload.pageId = page.pageid;
			payload.title = page.title;
			payload.url = getPageUrl( page.title );

			if ( needsMetadata ) {
				payload.userid = rev.userid;
				payload.user = rev.user;
				payload.timestamp = rev.timestamp;
				payload.comment = rev.comment;
				payload.size = rev.size;
				payload.minor = rev.minor ?? false;
			}

			if ( needsSource && rev.content !== undefined ) {
				payload.source = rev.content;
			}
		}

		if ( content === ContentFormat.html ) {
			const parseResult = await mwn.request( {
				action: 'parse',
				oldid: revisionId,
				prop: 'text',
				formatversion: '2'
			} );
			payload.html = parseResult.parse?.text;

			if ( payload.revisionId === undefined ) {
				payload.revisionId = revisionId;
				if ( parseResult.parse?.pageid !== undefined ) {
					payload.pageId = parseResult.parse.pageid;
				}
				if ( parseResult.parse?.title !== undefined ) {
					payload.title = parseResult.parse.title;
					payload.url = getPageUrl( parseResult.parse.title );
				}
			}
		}

		return structuredResult( payload );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve revision data: ${ ( error as Error ).message }`, code );
	}
}
