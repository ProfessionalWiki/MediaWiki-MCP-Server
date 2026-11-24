import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { neowikiRequest } from './neowikiRequest.ts';
import { formatEditComment } from '../../../wikis/utils.ts';

const inputSchema = {
	name: z.string().min(1).describe('Name of the Schema to delete.'),
	comment: z.string().optional().describe('Optional reason for the deletion.'),
} as const;

export const neowikiDeleteSchema: Tool<typeof inputSchema> = {
	name: 'neowiki-delete-schema',
	description:
		'Deletes a NeoWiki Schema, even one that Subjects still follow: they keep their Statements but follow no Schema until one of that name exists again. List them first with neowiki-list-subjects. Enabled only when the wiki has NeoWiki installed. A Schema is a page in the Schema namespace, so undelete-page restores it, and deleting it requires the right to delete pages; for a Schema with subjectsAreControlled, also the neowiki-controlled-subject-edit right.',
	inputSchema,
	annotations: {
		title: 'Delete NeoWiki schema',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'delete NeoWiki schema',
	target: (a) => a.name,

	async handle({ name, comment }, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const reason = formatEditComment(ctx, 'neowiki-delete-schema', comment);
		// The endpoint answers success with an empty body.
		await neowikiRequest(mwn, {
			method: 'DELETE',
			path: `/schema/${encodeURIComponent(name)}`,
			csrf: true,
			...(reason !== undefined ? { body: { comment: reason } } : {}),
		});

		return ctx.format.ok({ name, status: 'deleted' });
	},
};
