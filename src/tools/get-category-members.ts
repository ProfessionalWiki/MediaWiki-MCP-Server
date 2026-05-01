import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

enum CategoryMemberType {
	file = 'file',
	page = 'page',
	subcat = 'subcat',
}

interface CategoryMember {
	pageid: number;
	ns: number;
	title: string;
	type?: 'page' | 'file' | 'subcat';
}

function normalizeCategoryTitle(input: string): string {
	return /^category:/i.test(input) ? input : `Category:${input}`;
}

const inputSchema = {
	category: z.string().describe('Category name (with or without the "Category:" prefix)'),
	types: z
		.array(z.nativeEnum(CategoryMemberType))
		.optional()
		.describe('Types of members to include'),
	namespaces: z
		.array(z.number().int().nonnegative())
		.optional()
		.describe('Namespace IDs to filter by'),
	limit: z.number().int().min(1).max(500).optional().describe('Maximum members to return (1..500)'),
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque continuation token from the previous response; omit on first call'),
} as const;

export const getCategoryMembers: Tool<typeof inputSchema> = {
	name: 'get-category-members',
	description:
		"Lists members of a category, returning each member's page ID, namespace ID, and wiki page title. Optionally filter by member type (page, file, subcat) or by namespace ID — filters apply server-side before the cap. Returns up to 500 members per call; paginate with continueFrom (opaque cursor echoed from the previous response).",
	inputSchema,
	annotations: {
		title: 'Get category members',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'retrieve category members',
	target: (a) => a.category,

	async handle(
		{ category, types, namespaces, limit, continueFrom },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		const params: Record<string, string | number | boolean> = {
			action: 'query',
			list: 'categorymembers',
			cmtitle: normalizeCategoryTitle(category),
			cmprop: 'ids|title|type',
			formatversion: '2',
		};
		if (types && types.length > 0) {
			params.cmtype = types.join('|');
		}
		if (namespaces && namespaces.length > 0) {
			params.cmnamespace = namespaces.join('|');
		}
		params.cmlimit = limit ?? 500;
		if (continueFrom) {
			params.cmcontinue = continueFrom;
		}

		const response = await mwn.request(params);
		const members: CategoryMember[] = response.query?.categorymembers ?? [];

		const nextCursor: string | undefined = response.continue?.cmcontinue;
		const truncation: TruncationInfo | null = nextCursor
			? {
					reason: 'more-available',
					returnedCount: members.length,
					itemNoun: 'members',
					toolName: 'get-category-members',
					continueWith: { param: 'continueFrom', value: nextCursor },
				}
			: null;

		return ctx.format.ok({
			members: members.map((m) => ({
				title: m.title,
				pageId: m.pageid,
				namespace: m.ns,
				...(m.type !== undefined ? { type: m.type } : {}),
			})),
			...(truncation !== null ? { truncation } : {}),
		});
	},
};
