import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';

const inputSchema = {
	count: z.number().int().min(1).max(1000).describe('Number of Subject IDs to mint.'),
} as const;

interface MintResponse {
	subjectIds?: string[];
}

export const neowikiMintSubjectIds: Tool<typeof inputSchema> = {
	name: 'neowiki-mint-subject-ids',
	description:
		'Mints unused NeoWiki Subject IDs and returns them as subjectIds, without writing anything. Enabled only when the wiki has NeoWiki installed. A minted ID lets a relation target a Subject in the same write that creates it: the ID of each Dependent Subject passed in the dependentSubjects of neowiki-create-subject or neowiki-update-subject. Pre-1.0: the NeoWiki API may change without notice.',
	inputSchema,
	annotations: {
		title: 'Mint NeoWiki subject IDs',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'mint NeoWiki subject IDs',

	async handle({ count }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- NeoWiki /subject-ids response shape; trusted at this boundary
		const data = (await neowikiRequest(mwn, {
			method: 'POST',
			path: '/subject-ids',
			body: { count },
		})) as MintResponse;

		return ctx.format.ok({ subjectIds: Array.isArray(data.subjectIds) ? data.subjectIds : [] });
	},
};
