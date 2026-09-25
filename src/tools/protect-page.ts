import { z } from 'zod';
import type { Mwn } from 'mwn';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { formatEditComment } from '../wikis/utils.ts';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	protections: z
		.record(z.string(), z.string())
		.describe(
			'Protection level for each action, e.g. {"edit": "autoconfirmed", "move": "sysop"}. The actions are edit and move, plus upload on a File page; a page that does not exist takes only create, which stops the title being created. Levels are the wiki\'s own; MediaWiki\'s defaults are autoconfirmed (semi-protection) and sysop (full protection). "all" lifts the action\'s protection.',
		),
	expiry: z
		.string()
		.default('infinite')
		.describe(
			'When the protections named in protections end: infinite, a relative time such as "1 week", or a timestamp such as 2026-10-01T00:00:00Z.',
		),
	cascade: z
		.boolean()
		.optional()
		.describe(
			'Also protect every page transcluded into this one. Applies only while edit protection is at a cascading level, sysop by default. Omit to keep the current setting.',
		),
	comment: z.string().optional().describe('Reason for changing the protection'),
} as const;

interface Protection {
	action: string;
	level: string;
	expiry: string;
}

interface CurrentProtection {
	type: string;
	level: string;
	expiry: string;
	cascade?: boolean;
	// Set when the protection is inherited from a cascading page rather than the page's own.
	source?: string;
}

interface ProtectionRead {
	curtimestamp: string;
	query?: { pages?: { protection?: CurrentProtection[] }[] };
}

interface ProtectResponse {
	protect: {
		title: string;
		cascade?: boolean;
		// Each entry holds one action keyed to its level, "" for lifted, beside its expiry.
		protections: Record<string, string>[];
	};
}

export const protectPage: Tool<typeof inputSchema> = {
	name: 'protect-page',
	description:
		'Changes the protection of a wiki page and returns its title, the protections in effect afterwards with their expiries, and whether cascading is on. Each action named in protections is set to its level until expiry; the level "all" lifts that action\'s protection. Actions left out keep their current protection, so lifting all protection means naming each protected action with "all". Fails if the authenticated user lacks the protect permission, if the wiki does not accept an action or level for this page, or if the expiry is invalid or in the past.',
	inputSchema,
	annotations: {
		title: 'Protect page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'protect page',
	target: (a) => a.title,

	async handle(
		{ title, protections, expiry, cascade, comment },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const requested: Protection[] = Object.entries(protections).map(([action, level]) => ({
			action,
			level,
			expiry,
		}));
		if (requested.length === 0) {
			return ctx.format.error('invalid_input', 'protections must name at least one action');
		}

		const mwn = await ctx.mwn();
		// The wiki lifts the protection of every action a request leaves out, so
		// the page's other protections are sent again to keep them.
		const current = await protectionsInForce(mwn, title);
		const kept: Protection[] = current
			.filter((p) => !Object.hasOwn(protections, p.type))
			.map((p) => ({ action: p.type, level: p.level, expiry: p.expiry }));
		const applied = [...requested, ...kept];

		const params = {
			action: 'protect',
			title,
			protections: applied.map((p) => `${p.action}=${p.level}`),
			expiry: applied.map((p) => p.expiry),
			cascade: cascade ?? current.some((p) => p.cascade === true),
			reason: formatEditComment(ctx, 'protect-page', comment),
		};
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=protect response shape; trusted at this boundary
		const response = (await ctx.edit.submit(mwn, params)) as ProtectResponse;

		return ctx.format.ok({
			title: response.protect.title,
			protections: response.protect.protections.flatMap(fromResponse).filter((p) => p.level !== ''),
			cascade: response.protect.cascade === true,
		});
	},
};

// The page's own protections, leaving out those inherited from a cascading page
// and those already expired. An expired protection stays listed until the wiki
// next purges it, and sending one again fails the whole request as an expiry in
// the past; it is judged by the wiki's clock, which the host's need not match.
async function protectionsInForce(mwn: Mwn, title: string): Promise<CurrentProtection[]> {
	const params = {
		action: 'query',
		prop: 'info',
		inprop: 'protection',
		titles: title,
		curtimestamp: true,
		formatversion: '2',
	};
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
	const response = (await mwn.request(params)) as ProtectionRead;
	const now = Date.parse(response.curtimestamp);
	return (response.query?.pages?.[0]?.protection ?? []).filter(
		(p) => p.source === undefined && inForceAt(p.expiry, now),
	);
}

// "infinity" does not parse as a date, so it is kept.
function inForceAt(expiry: string, now: number): boolean {
	const end = Date.parse(expiry);
	return Number.isNaN(end) || end > now;
}

function fromResponse({ expiry, ...levelByAction }: Record<string, string>): Protection[] {
	return Object.entries(levelByAction).map(([action, level]) => ({ action, level, expiry }));
}
