import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { appendTruncationMarker, type TruncationInfo } from '../common/truncation.js';
import { classifyError, errorResult } from '../common/errorMapping.js';

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

function formatUser( change: RecentChange ): string {
	if ( change.userhidden ) {
		return 'User: (hidden)';
	}
	if ( change.anon ) {
		return `User: ${ change.user } (anonymous)`;
	}
	return `User: ${ change.user } (ID: ${ change.userid })`;
}

function formatFlags( change: RecentChange ): string | undefined {
	const flags: string[] = [];
	if ( change.minor ) {
		flags.push( 'minor' );
	}
	if ( change.bot ) {
		flags.push( 'bot' );
	}
	if ( change.new ) {
		flags.push( 'new' );
	}
	if ( change.anon ) {
		flags.push( 'anon' );
	}
	return flags.length > 0 ? `Flags: ${ flags.join( ', ' ) }` : undefined;
}

function formatLogParams( params: Record<string, unknown> ): string {
	return Object.entries( params )
		.map( ( [ key, value ] ) => `${ key }=${ Array.isArray( value ) ? value.join( '|' ) : String( value ) }` )
		.join( ', ' );
}

function formatChange( change: RecentChange ): TextContent {
	const lines: string[] = [
		`Type: ${ change.type }`,
		`Title: ${ change.title }`,
		`Timestamp: ${ change.timestamp }`,
		formatUser( change )
	];

	if ( change.type !== 'log' && change.revid !== undefined ) {
		const fromSuffix = change.old_revid && change.old_revid !== 0 ?
			` (from ${ change.old_revid })` :
			'';
		lines.push( `Revision: ${ change.revid }${ fromSuffix }` );
	}

	if ( change.type !== 'log' && change.newlen !== undefined ) {
		const delta = change.newlen - ( change.oldlen ?? 0 );
		const sign = delta >= 0 ? '+' : '';
		lines.push( `Size: ${ change.newlen } bytes (${ sign }${ delta })` );
	}

	if ( !change.commenthidden && change.comment ) {
		lines.push( `Comment: ${ change.comment }` );
	}

	if ( change.type === 'log' && change.logtype && change.logaction ) {
		const paramsStr = change.logparams && Object.keys( change.logparams ).length > 0 ?
			` (${ formatLogParams( change.logparams ) })` :
			'';
		lines.push( `Log: ${ change.logtype }/${ change.logaction }${ paramsStr }` );
	}

	const flagsLine = formatFlags( change );
	if ( flagsLine ) {
		lines.push( flagsLine );
	}

	if ( change.tags && change.tags.length > 0 ) {
		lines.push( `Tags: ${ change.tags.join( ', ' ) }` );
	}

	if ( change.unpatrolled === true ) {
		lines.push( 'Unpatrolled: yes' );
	}

	return { type: 'text', text: lines.join( '\n' ) };
}

export function getRecentChangesTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-recent-changes',
		'Returns recent change events, newest first, in segments of 50. Defaults to edits and page creations; set types to include log actions, categorizations, or external changes. Each row includes title, timestamp, user, revision IDs, size change, flags (minor/bot/new/anon), tags, and change type. Filter by timestamp window, namespaces, user, change tag, or hide flags (hideBots/hideMinor/hideAnon/hideRedirects/hidePatrolled). Pass showPatrolStatus to include per-row patrol state (requires patrol rights). Paginate with the continue token from the truncation marker. For a single page\'s revision history, use get-page-history.',
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

		if ( changes.length === 0 ) {
			return {
				content: [ {
					type: 'text',
					text: 'No recent changes matched the filters'
				} as TextContent ]
			};
		}

		const content: TextContent[] = changes.map( formatChange );

		const nextCursor: string | undefined = response.continue?.rccontinue;
		const truncation: TruncationInfo | null = nextCursor ? {
			reason: 'more-available',
			returnedCount: changes.length,
			itemNoun: 'changes',
			toolName: 'get-recent-changes',
			continueWith: { param: 'continue', value: nextCursor }
		} : null;

		return { content: appendTruncationMarker( content, truncation ) };
	} catch ( error ) {
		const { category } = classifyError( error );
		return errorResult( category, `Failed to retrieve recent changes: ${ ( error as Error ).message }` );
	}
}
