import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ApiRevision } from 'mwn';

const PAGE_HISTORY_LIMIT = 20;

export function getPageHistoryTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page-history',
		`Returns information about the latest revisions to a wiki page, in segments of ${ PAGE_HISTORY_LIMIT } revisions, starting with the latest revision.`,
		{
			title: z.string().describe( 'Wiki page title' ),
			olderThan: z.number().int().positive().optional().describe( 'Revision ID — return revisions older than this' ),
			newerThan: z.number().int().positive().optional().describe( 'Revision ID — return revisions newer than this' ),
			filter: z.string().optional().describe( 'Filter that returns only revisions with certain tags' )
		},
		{
			title: 'Get page history',
			readOnlyHint: true,
			destructiveHint: false
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

		return {
			content: filteredRevisions.map( ( rev ): TextContent => ( {
				type: 'text',
				text: [
					`Revision ID: ${ rev.revid }`,
					`Timestamp: ${ rev.timestamp }`,
					`User: ${ rev.user } (ID: ${ rev.userid })`,
					`Comment: ${ rev.comment }`,
					`Size: ${ rev.size }`,
					`Minor: ${ rev.minor ?? false }`
				].join( '\n' )
			} ) )
		};
	} catch ( error ) {
		return {
			content: [
				{ type: 'text', text: `Failed to retrieve page history: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}
}
