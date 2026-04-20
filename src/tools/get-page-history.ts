import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { ApiPage, ApiRevision } from 'mwn';

export function getPageHistoryTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page-history',
		'Returns information about the latest revisions to a wiki page, in segments of 20 revisions, starting with the latest revision.',
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
			// Fetch one extra when a boundary is set, since rvendid/rvstartid
			// are inclusive and we filter the boundary out below.
			rvlimit: boundaryId ? 21 : 20,
			formatversion: '2'
		};

		if ( olderThan ) {
			params.rvendid = olderThan;
		}

		if ( newerThan ) {
			params.rvstartid = newerThan;
			params.rvdir = 'newer';
		}

		if ( filter ) {
			params.rvtag = filter;
		}

		const response = await mwn.request( params );
		const page = response.query?.pages?.[ 0 ] as ApiPage | undefined;
		const revisions: ApiRevision[] = page?.revisions ?? [];

		// rvendid/rvstartid are inclusive — filter out the boundary revision
		// to preserve the exclusive semantics of olderThan/newerThan
		const filteredRevisions = boundaryId ?
			revisions.filter( ( rev ) => rev.revid !== boundaryId ) :
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
