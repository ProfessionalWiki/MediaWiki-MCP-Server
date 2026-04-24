import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import type { TruncationInfo } from '../common/truncation.js';
import { TruncationSchema } from '../common/schemas.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

const RC_LIMIT = 50;
const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo';

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
		'Omit patrolled edits. Requires patrol rights.'
	),
	showPatrolStatus: z.boolean().optional().describe(
		'Include per-row patrol status; adds an "Unpatrolled: yes" line to unpatrolled rows. Requires patrol rights.'
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
	showPatrolStatus?: boolean;
	continue?: string;
};

interface RecentChange {
	type: 'edit' | 'new' | 'log' | 'categorize' | 'external';
	title: string;
	timestamp: string;
	user?: string;
	userid?: number;
	anon?: boolean;
	userhidden?: boolean;
	commenthidden?: boolean;
	revid?: number;
	old_revid?: number;
	newlen?: number;
	oldlen?: number;
	comment?: string;
	minor?: boolean;
	bot?: boolean;
	new?: boolean;
	redirect?: boolean;
	unpatrolled?: boolean;
	tags?: string[];
	logtype?: string;
	logaction?: string;
	logparams?: Record<string, unknown>;
}

const RecentChangeSchema = z.object( {
	type: z.enum( [ 'edit', 'new', 'log', 'categorize', 'external' ] ),
	title: z.string(),
	timestamp: z.string(),
	user: z.string().optional(),
	userid: z.number().int().nonnegative().optional(),
	anon: z.boolean().optional(),
	userhidden: z.boolean().optional(),
	commenthidden: z.boolean().optional(),
	revid: z.number().int().nonnegative().optional(),
	oldRevid: z.number().int().nonnegative().optional(),
	newlen: z.number().int().nonnegative().optional(),
	oldlen: z.number().int().nonnegative().optional(),
	sizeDelta: z.number().int().optional(),
	comment: z.string().optional(),
	minor: z.boolean().optional(),
	bot: z.boolean().optional(),
	isNew: z.boolean().optional(),
	redirect: z.boolean().optional(),
	unpatrolled: z.boolean().optional(),
	tags: z.array( z.string() ).optional(),
	logtype: z.string().optional(),
	logaction: z.string().optional(),
	logparams: z.record( z.string(), z.unknown() ).optional()
} );

const outputSchema = {
	changes: z.array( RecentChangeSchema ),
	truncation: TruncationSchema.optional()
};

export function getRecentChangesTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'get-recent-changes',
		{
			description: 'Returns recent change events, newest first, in segments of 50. Defaults to edits and page creations; set types to include log actions, categorizations, or external changes. Each row includes title, timestamp, user, revision IDs, size change, flags (minor/bot/new/anon), tags, and change type. Filter by timestamp window, namespaces, user, change tag, or hide flags (hideBots/hideMinor/hideAnon/hideRedirects/hidePatrolled). Pass showPatrolStatus to include per-row patrol state (requires patrol rights). Paginate with the continue token from the truncation marker. For a single page\'s revision history, use get-page-history.',
			inputSchema,
			outputSchema,
			annotations: {
				title: 'Get recent changes',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
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
		return errorResult( 'invalid_input', 'user and excludeUser are mutually exclusive' );
	}

	try {
		const mwn = await getMwn();

		const types = args.types ?? [ 'edit', 'new' ];

		const rcprop = args.showPatrolStatus ? `${ RC_PROP }|patrolled` : RC_PROP;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'recentchanges',
			rctype: types.join( '|' ),
			rclimit: RC_LIMIT,
			rcdir: 'older',
			rcprop,
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
		const changes = ( response.query?.recentchanges ?? [] ) as RecentChange[];

		const nextCursor: string | undefined = response.continue?.rccontinue;
		const truncation: TruncationInfo | null = nextCursor ? {
			reason: 'more-available',
			returnedCount: changes.length,
			itemNoun: 'changes',
			toolName: 'get-recent-changes',
			continueWith: { param: 'continue', value: nextCursor }
		} : null;

		return structuredResult( {
			changes: changes.map( ( c ) => {
				const sizeDelta = ( c.newlen !== undefined && c.oldlen !== undefined ) ?
					c.newlen - c.oldlen :
					undefined;
				return {
					type: c.type,
					title: c.title,
					timestamp: c.timestamp,
					user: c.user,
					userid: c.userid,
					anon: c.anon,
					userhidden: c.userhidden,
					commenthidden: c.commenthidden,
					revid: c.revid,
					oldRevid: c.old_revid,
					newlen: c.newlen,
					oldlen: c.oldlen,
					sizeDelta,
					comment: c.commenthidden ? undefined : c.comment,
					minor: c.minor,
					bot: c.bot,
					isNew: c.new,
					redirect: c.redirect,
					unpatrolled: c.unpatrolled,
					tags: c.tags,
					logtype: c.logtype,
					logaction: c.logaction,
					logparams: c.logparams
				};
			} ),
			...( truncation !== null ? { truncation } : {} )
		} );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve recent changes: ${ ( error as Error ).message }`, code );
	}
}
