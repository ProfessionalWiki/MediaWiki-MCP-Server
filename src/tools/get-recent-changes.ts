import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { appendTruncationMarker, type TruncationInfo } from '../common/truncation.js';

const RC_LIMIT = 50;
const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo|patrolled';

const RcType = z.enum( [ 'edit', 'new', 'log', 'categorize', 'external' ] );

const inputSchema = {
	since: z.string().optional().describe(
		'ISO 8601 timestamp — only return changes at or after this time'
	),
	until: z.string().optional().describe(
		'ISO 8601 timestamp — only return changes at or before this time'
	),
	namespace: z.array( z.number().int().nonnegative() ).nonempty().optional().describe(
		'Namespace IDs to restrict the feed to — e.g. [0, 1] for main and talk'
	),
	types: z.array( RcType ).nonempty().optional().describe(
		'Event types to include. Defaults to edit and new (content changes only).'
	),
	user: z.string().optional().describe(
		'Username — return only changes by this user. Mutually exclusive with excludeUser.'
	),
	excludeUser: z.string().optional().describe(
		'Username — exclude changes by this user. Mutually exclusive with user.'
	),
	tag: z.string().optional().describe(
		'Change tag — return only changes carrying this tag'
	),
	hideBots: z.boolean().optional().describe( 'Omit bot-flagged edits' ),
	hideMinor: z.boolean().optional().describe( 'Omit minor-flagged edits' ),
	hideAnon: z.boolean().optional().describe( 'Omit edits by anonymous users' ),
	hideRedirects: z.boolean().optional().describe( 'Omit changes whose target is a redirect' ),
	hidePatrolled: z.boolean().optional().describe(
		'Omit patrolled edits (requires patrol rights on the wiki)'
	),
	continue: z.string().optional().describe(
		"Continuation token from a prior call's truncation marker"
	)
};

type RecentChangesArgs = {
	since?: string;
	until?: string;
	namespace?: number[];
	types?: z.infer<typeof RcType>[];
	user?: string;
	excludeUser?: string;
	tag?: string;
	hideBots?: boolean;
	hideMinor?: boolean;
	hideAnon?: boolean;
	hideRedirects?: boolean;
	hidePatrolled?: boolean;
	continue?: string;
};

export function getRecentChangesTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-recent-changes',
		'Returns recent change events on a wiki (edits and page creations by default; log actions, categorizations, and external changes via types), newest first, in segments of 50. Each row includes title, timestamp, user, revision IDs, size change, flags (minor/bot/new/anon), tags, and change type. Filter by timestamp window, namespaces, user, change tag, or noise flags (hideBots/hideMinor/hideAnon/hideRedirects/hidePatrolled). Paginate with the continue token from the truncation marker. For a single page\'s revision history, use get-page-history.',
		inputSchema,
		{
			title: 'Get recent changes',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( args ) => handleGetRecentChangesTool( args as RecentChangesArgs )
	);
}

function buildRcShow( args: RecentChangesArgs ): string | undefined {
	const parts: string[] = [];
	if ( args.hideBots ) {
		parts.push( '!bot' );
	}
	if ( args.hideMinor ) {
		parts.push( '!minor' );
	}
	if ( args.hideAnon ) {
		parts.push( '!anon' );
	}
	if ( args.hideRedirects ) {
		parts.push( '!redirect' );
	}
	if ( args.hidePatrolled ) {
		parts.push( '!patrolled' );
	}
	return parts.length > 0 ? parts.join( '|' ) : undefined;
}

export async function handleGetRecentChangesTool(
	args: RecentChangesArgs
): Promise<CallToolResult> {
	if ( args.user && args.excludeUser ) {
		return {
			content: [ {
				type: 'text',
				text: 'Cannot use both user and excludeUser at the same time'
			} as TextContent ],
			isError: true
		};
	}

	try {
		const mwn = await getMwn();

		const types = args.types ?? [ 'edit', 'new' ];

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'recentchanges',
			rctype: types.join( '|' ),
			rclimit: RC_LIMIT,
			rcdir: 'older',
			rcprop: RC_PROP,
			formatversion: '2'
		};

		if ( args.since !== undefined ) {
			params.rcend = args.since;
		}
		if ( args.until !== undefined ) {
			params.rcstart = args.until;
		}
		if ( args.namespace && args.namespace.length > 0 ) {
			params.rcnamespace = args.namespace.join( '|' );
		}
		if ( args.user !== undefined ) {
			params.rcuser = args.user;
		}
		if ( args.excludeUser !== undefined ) {
			params.rcexcludeuser = args.excludeUser;
		}
		if ( args.tag !== undefined ) {
			params.rctag = args.tag;
		}
		const rcshow = buildRcShow( args );
		if ( rcshow !== undefined ) {
			params.rcshow = rcshow;
		}
		if ( args.continue !== undefined ) {
			params.rccontinue = args.continue;
		}

		const response = await mwn.request( params );
		const changes = ( response.query?.recentchanges ?? [] ) as unknown[];

		// Minimal placeholder formatter — Task 2 replaces this.
		const content: TextContent[] = changes.map( ( _c ): TextContent => ( {
			type: 'text',
			text: 'change'
		} ) );

		const truncation: TruncationInfo | null = null; // Task 3 wires this.

		return { content: appendTruncationMarker( content, truncation ) };
	} catch ( error ) {
		return {
			content: [ {
				type: 'text',
				text: `Failed to retrieve recent changes: ${ ( error as Error ).message }`
			} as TextContent ],
			isError: true
		};
	}
}
