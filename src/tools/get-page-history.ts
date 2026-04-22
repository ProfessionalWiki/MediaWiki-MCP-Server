import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ApiRevision } from 'mwn';
import { appendTruncationMarker, type TruncationInfo } from '../common/truncation.js';

const PAGE_HISTORY_LIMIT = 20;

export function getPageHistoryTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page-history',
		`Returns revision metadata (revision ID, timestamp, user, comment, size, minor flag) for a wiki page, in segments of ${ PAGE_HISTORY_LIMIT } revisions, newest first. Paginate with olderThan or newerThan (mutually exclusive). If the title does not exist, an error is returned.`,
		{
			title: z.string().describe( 'Wiki page title' ),
			olderThan: z.number().int().positive().optional().describe( 'Revision ID — return revisions older than this (exclusive). Mutually exclusive with newerThan.' ),
			newerThan: z.number().int().positive().optional().describe( 'Revision ID — return revisions newer than this (exclusive). Mutually exclusive with olderThan.' ),
			filter: z.string().optional().describe( 'Change tag — return only revisions carrying this tag' )
		},
		{
			title: 'Get page history',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async (
			{ title, olderThan, newerThan, filter }
		) => handleGetPageHistoryTool( title, olderThan, newerThan, filter )
	);
}

export async function handleGetPageHistoryTool(
	title: string,
	olderThan?: number,
	newerThan?: number,
	filter?: string
): Promise<CallToolResult> {
	if ( olderThan && newerThan ) {
		return {
			content: [ {
				type: 'text',
				text: 'Cannot use both olderThan and newerThan at the same time'
			} ],
			isError: true
		};
	}

	try {
		const mwn = await getMwn();
		const boundaryId = olderThan ?? newerThan;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			prop: 'revisions',
			titles: title,
			rvprop: 'ids|timestamp|user|userid|comment|size|flags',
			// Fetch one extra when a boundary is set, since rvstartid is
			// inclusive and we filter the boundary out below.
			rvlimit: PAGE_HISTORY_LIMIT + ( boundaryId ? 1 : 0 ),
			formatversion: '2'
		};

		// Both olderThan and newerThan use rvstartid (the enumeration anchor);
		// they differ only in direction. Default rvdir=older walks newest →
		// oldest, so olderThan needs no rvdir override.
		if ( boundaryId ) {
			params.rvstartid = boundaryId;
			if ( newerThan ) {
				params.rvdir = 'newer';
			}
		}

		if ( filter ) {
			params.rvtag = filter;
		}

		const response = await mwn.request( params );
		const page = response.query?.pages?.[ 0 ] as ApiPage | undefined;

		if ( page?.missing ) {
			return {
				content: [ {
					type: 'text',
					text: `Page "${ title }" not found`
				} as TextContent ],
				isError: true
			};
		}

		const revisions: ApiRevision[] = page?.revisions ?? [];

		// rvstartid is inclusive — filter out the boundary revision to
		// preserve the exclusive semantics of olderThan/newerThan, and cap
		// the result in case the boundary was absent from the window.
		const filteredRevisions = boundaryId ?
			revisions.filter( ( rev ) => rev.revid !== boundaryId ).slice( 0, PAGE_HISTORY_LIMIT ) :
			revisions;

		if ( filteredRevisions.length === 0 ) {
			return {
				content: [
					{ type: 'text', text: 'No revisions found for page' } as TextContent
				]
			};
		}

		const content: TextContent[] = filteredRevisions.map( ( rev ): TextContent => ( {
			type: 'text',
			text: [
				`Revision ID: ${ rev.revid }`,
				`Timestamp: ${ rev.timestamp }`,
				`User: ${ rev.user } (ID: ${ rev.userid })`,
				`Comment: ${ rev.comment }`,
				`Size: ${ rev.size }`,
				`Minor: ${ rev.minor ?? false }`
			].join( '\n' )
		} ) );

		let truncation: TruncationInfo | null = null;
		if ( response.continue?.rvcontinue && filteredRevisions.length > 0 ) {
			// The response is always ordered from the boundary side to the
			// advance side: default rvdir=older walks newest→oldest (last item
			// is the oldest), rvdir=newer walks oldest→newest (last item is
			// the newest). The last item is always what the caller should
			// advance past; only the param name differs.
			const walkingForward = newerThan !== undefined;
			const anchorRev = filteredRevisions[ filteredRevisions.length - 1 ].revid!;
			truncation = {
				reason: 'more-available',
				returnedCount: filteredRevisions.length,
				itemNoun: 'revisions',
				toolName: 'get-page-history',
				continueWith: {
					param: walkingForward ? 'newerThan' : 'olderThan',
					value: anchorRev
				}
			};
		}

		return { content: appendTruncationMarker( content, truncation ) };
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve page history: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
