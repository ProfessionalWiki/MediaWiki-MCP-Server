import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

const RC_LIMIT = 50;
const RC_PROP = 'user|userid|comment|flags|timestamp|title|ids|sizes|tags|loginfo';

const RcType = z.enum(['edit', 'new', 'log', 'categorize', 'external']);

const inputSchema = {
	since: z
		.string()
		.optional()
		.describe('ISO 8601 timestamp — only return changes at or after this time'),
	until: z
		.string()
		.optional()
		.describe('ISO 8601 timestamp — only return changes at or before this time'),
	namespace: z
		.array(z.number().int().nonnegative())
		.nonempty()
		.optional()
		.describe('Namespace IDs to restrict the feed to — e.g. [0, 1] for main and talk'),
	types: z
		.array(RcType)
		.nonempty()
		.optional()
		.describe('Event types to include. Defaults to edit and new (content changes only).'),
	user: z
		.string()
		.optional()
		.describe('Username — return only changes by this user. Mutually exclusive with excludeUser.'),
	excludeUser: z
		.string()
		.optional()
		.describe('Username — exclude changes by this user. Mutually exclusive with user.'),
	tag: z.string().optional().describe('Change tag — return only changes carrying this tag'),
	hideBots: z.boolean().optional().describe('Omit bot-flagged edits'),
	hideMinor: z.boolean().optional().describe('Omit minor-flagged edits'),
	hideAnon: z.boolean().optional().describe('Omit edits by anonymous users'),
	hideRedirects: z.boolean().optional().describe('Omit changes whose target is a redirect'),
	hidePatrolled: z.boolean().optional().describe('Omit patrolled edits. Requires patrol rights.'),
	showPatrolStatus: z
		.boolean()
		.optional()
		.describe(
			'Include per-row patrol status; adds an "Unpatrolled: yes" line to unpatrolled rows. Requires patrol rights.',
		),
	continue: z
		.string()
		.optional()
		.describe("Continuation token from a prior call's truncation marker"),
} as const;

type RecentChangesArgs = z.infer<z.ZodObject<typeof inputSchema>>;

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

function buildRcShow(args: RecentChangesArgs): string | undefined {
	const parts: string[] = [];
	if (args.hideBots) {
		parts.push('!bot');
	}
	if (args.hideMinor) {
		parts.push('!minor');
	}
	if (args.hideAnon) {
		parts.push('!anon');
	}
	if (args.hideRedirects) {
		parts.push('!redirect');
	}
	if (args.hidePatrolled) {
		parts.push('!patrolled');
	}
	return parts.length > 0 ? parts.join('|') : undefined;
}

export const getRecentChanges: Tool<typeof inputSchema> = {
	name: 'get-recent-changes',
	description:
		"Returns recent change events, newest first, in segments of 50. Defaults to edits and page creations; set types to include log actions, categorizations, or external changes. Each row includes title, timestamp, user, revision IDs, size change, flags (minor/bot/new/anon), tags, and change type. Filter by timestamp window, namespaces, user, change tag, or hide flags (hideBots/hideMinor/hideAnon/hideRedirects/hidePatrolled). Pass showPatrolStatus to include per-row patrol state (requires patrol rights). Paginate with the continue token from the truncation marker. For a single page's revision history, use get-page-history.",
	inputSchema,
	annotations: {
		title: 'Get recent changes',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve recent changes',

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		if (args.user && args.excludeUser) {
			return ctx.format.invalidInput('user and excludeUser are mutually exclusive');
		}

		const mwn = await ctx.mwn();

		const types = args.types ?? ['edit', 'new'];

		const rcprop = args.showPatrolStatus ? `${RC_PROP}|patrolled` : RC_PROP;

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'recentchanges',
			rctype: types.join('|'),
			rclimit: RC_LIMIT,
			rcdir: 'older',
			rcprop,
			formatversion: '2',
		};

		if (args.since !== undefined) {
			params.rcend = args.since;
		}
		if (args.until !== undefined) {
			params.rcstart = args.until;
		}
		if (args.namespace && args.namespace.length > 0) {
			params.rcnamespace = args.namespace.join('|');
		}
		if (args.user !== undefined) {
			params.rcuser = args.user;
		}
		if (args.excludeUser !== undefined) {
			params.rcexcludeuser = args.excludeUser;
		}
		if (args.tag !== undefined) {
			params.rctag = args.tag;
		}
		const rcshow = buildRcShow(args);
		if (rcshow !== undefined) {
			params.rcshow = rcshow;
		}
		if (args.continue !== undefined) {
			params.rccontinue = args.continue;
		}

		const response = await mwn.request(params);
		const changes = (response.query?.recentchanges ?? []) as RecentChange[];

		const nextCursor: string | undefined = response.continue?.rccontinue;
		const truncation: TruncationInfo | null = nextCursor
			? {
					reason: 'more-available',
					returnedCount: changes.length,
					itemNoun: 'changes',
					toolName: 'get-recent-changes',
					continueWith: { param: 'continue', value: nextCursor },
				}
			: null;

		return ctx.format.ok({
			changes: changes.map((c) => {
				const sizeDelta =
					c.newlen !== undefined && c.oldlen !== undefined ? c.newlen - c.oldlen : undefined;
				return {
					type: c.type,
					title: c.title,
					timestamp: c.timestamp,
					user: c.user,
					userid: c.userid,
					anon: c.anon,
					userhidden: c.userhidden,
					commenthidden: c.commenthidden,
					revisionId: c.revid,
					oldRevisionId: c.old_revid,
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
					logparams: c.logparams,
				};
			}),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
