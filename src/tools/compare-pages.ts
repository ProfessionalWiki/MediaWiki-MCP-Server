import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { inlineDiffToText } from '../results/diffFormat.js';
import { truncateByBytes } from '../results/truncation.js';

interface CompareResponse {
	fromrevid?: number;
	fromtitle?: string;
	fromsize?: number;
	fromtimestamp?: string;
	torevid?: number;
	totitle?: string;
	tosize?: number;
	totimestamp?: string;
	body?: string;
	diffsize?: number;
}

type Side = 'from' | 'to';

const inputSchema = {
	fromRevision: z.number().int().positive().optional().describe('Revision ID for the "from" side'),
	fromTitle: z
		.string()
		.optional()
		.describe('Wiki page title for the "from" side (latest revision is used)'),
	fromText: z.string().optional().describe('Supplied wikitext for the "from" side'),
	toRevision: z.number().int().positive().optional().describe('Revision ID for the "to" side'),
	toTitle: z
		.string()
		.optional()
		.describe('Wiki page title for the "to" side (latest revision is used)'),
	toText: z.string().optional().describe('Supplied wikitext for the "to" side'),
	includeDiff: z
		.boolean()
		.optional()
		.describe(
			'Include the diff body (default true). Set false for a cheap change-detection response.',
		),
} as const;

type ComparePagesArgs = z.infer<z.ZodObject<typeof inputSchema>>;

function validateSide(side: Side, args: ComparePagesArgs): string | undefined {
	const count = [
		args[`${side}Revision` as const],
		args[`${side}Title` as const],
		args[`${side}Text` as const],
	].filter((v) => v !== undefined).length;
	if (count === 0) {
		return `Must supply exactly one of ${side}Revision, ${side}Title, ${side}Text`;
	}
	if (count > 1) {
		return `Only one of ${side}Revision, ${side}Title, ${side}Text may be supplied`;
	}
	return undefined;
}

function buildSideParams(side: Side, args: ComparePagesArgs): Record<string, string | number> {
	const rev = args[`${side}Revision` as const];
	const title = args[`${side}Title` as const];
	const text = args[`${side}Text` as const];
	if (rev !== undefined) {
		return { [`${side}rev`]: rev };
	}
	if (title !== undefined) {
		return { [`${side}title`]: title };
	}
	if (text !== undefined) {
		return { [`${side}slots`]: 'main', [`${side}text-main`]: text };
	}
	return {};
}

function detectChanged(compare: CompareResponse, diffText: string): boolean {
	if (compare.fromrevid !== undefined && compare.torevid !== undefined) {
		return compare.fromrevid !== compare.torevid;
	}
	if (compare.body !== undefined) {
		return diffText.length > 0;
	}
	if (compare.diffsize !== undefined) {
		return compare.diffsize > 0;
	}
	return (compare.fromsize ?? 0) !== (compare.tosize ?? 0);
}

// MediaWiki omits fromsize/tosize when the side is supplied text; we have the text
// locally, so compute the byte length. For title/revision sides where MW still
// omits size (rare) we leave the field undefined rather than reporting a misleading 0.
function computeSideSizes(
	compare: CompareResponse,
	args: ComparePagesArgs,
): {
	fromSize?: number;
	toSize?: number;
	sizeDelta?: number;
} {
	const byteLength = (text: string | undefined): number | undefined =>
		text !== undefined ? Buffer.byteLength(text, 'utf8') : undefined;
	const fromSize = compare.fromsize ?? byteLength(args.fromText);
	const toSize = compare.tosize ?? byteLength(args.toText);
	const sizeDelta = fromSize !== undefined && toSize !== undefined ? toSize - fromSize : undefined;
	return { fromSize, toSize, sizeDelta };
}

function buildSidePayload(
	side: Side,
	compare: CompareResponse,
	args: ComparePagesArgs,
	size: number | undefined,
	includeDiff: boolean,
): Record<string, unknown> {
	return {
		title: compare[`${side}title` as const],
		revisionId: compare[`${side}revid` as const],
		timestamp: includeDiff ? compare[`${side}timestamp` as const] : undefined,
		size,
		...(args[`${side}Text` as const] !== undefined ? { isSuppliedText: true } : {}),
	};
}

function buildPayload(
	compare: CompareResponse,
	args: ComparePagesArgs,
	includeDiff: boolean,
): Record<string, unknown> {
	const diffText = compare.body ? inlineDiffToText(compare.body) : '';
	const changed = detectChanged(compare, diffText);
	const { fromSize, toSize, sizeDelta } = computeSideSizes(compare, args);
	const payload: Record<string, unknown> = {
		changed,
		from: buildSidePayload('from', compare, args, fromSize, includeDiff),
		to: buildSidePayload('to', compare, args, toSize, includeDiff),
		...(sizeDelta !== undefined ? { sizeDelta } : {}),
	};
	if (includeDiff && changed && diffText) {
		const truncated = truncateByBytes(diffText);
		payload.diff = truncated.text;
		if (truncated.truncated) {
			payload.truncation = {
				reason: 'content-truncated',
				returnedBytes: truncated.returnedBytes,
				totalBytes: truncated.totalBytes,
				itemNoun: 'diff',
				toolName: 'compare-pages',
				remedyHint:
					'To avoid truncation, compare a narrower revision range or set includeDiff=false for a metadata-only response.',
			};
		}
	}
	return payload;
}

export const comparePages: Tool<typeof inputSchema> = {
	name: 'compare-pages',
	description:
		'Returns the changes between two versions of a wiki page as a compact text diff. Each side accepts a revision ID, page title (latest revision), or supplied wikitext; text-vs-text is rejected. Only the changes are returned over the wire. For the full text of both sides, fetch with get-page instead. If a title or revision ID does not exist, an error is returned. Set includeDiff=false for a cheap change-detection response that skips diff rendering and returns just the change flag, revision metadata, and size delta. Diff output is truncated at 50000 bytes with a trailing marker; a narrower revision range or includeDiff=false avoids truncation.',
	inputSchema,
	annotations: {
		title: 'Compare pages',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'compare pages',

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const sideError = validateSide('from', args) ?? validateSide('to', args);
		if (sideError) {
			return ctx.format.invalidInput(sideError);
		}
		if (args.fromText !== undefined && args.toText !== undefined) {
			return ctx.format.invalidInput('Cannot compare supplied text against supplied text');
		}

		const includeDiff = args.includeDiff ?? true;
		const mwn = await ctx.mwn();
		const response = await mwn.request({
			action: 'compare',
			prop: includeDiff ? 'ids|title|size|timestamp|diff' : 'ids|title|size|diffsize',
			formatversion: '2',
			...buildSideParams('from', args),
			...buildSideParams('to', args),
		});
		const compare = response.compare as CompareResponse | undefined;
		if (!compare) {
			return ctx.format.error(
				'upstream_failure',
				'Failed to compare pages: no compare result returned',
			);
		}
		return ctx.format.ok(buildPayload(compare, args, includeDiff));
	},
};
