import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl, formatEditComment } from '../wikis/utils.ts';
import { childrenOf } from '../services/sectionSubtree.ts';

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

// `section='new'` was removed; a caller sending it gets this instead of a bare
// type error naming a number. Delete this constant and the `error` function
// below once the release carrying that removal has shipped — see the Breaking
// changes entry in CHANGELOG.md.
const SECTION_NEW_REMOVED =
	'update-page no longer creates sections. To add one, use mode=\'append\' with a source that begins with the heading, for example "\\n\\n== History ==\\n\\nBody.".';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	source: z
		.string()
		.describe(
			'The content to write, in the existing page\'s content model. Interpreted as the full page by default; as the given section\'s content when section is set; or as a delta (appended or prepended) when mode is set. An appended source that opens a new section must begin on its own line, as in "\\n\\n== History ==\\n\\nBody."; without the leading newline the heading runs on from the last line of the page and is not recognised as a heading.',
		),
	latestId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.',
		),
	comment: z.string().optional().describe('Summary of the edit'),
	section: z
		.number({
			error: (issue) => (issue.input === 'new' ? SECTION_NEW_REMOVED : undefined),
		})
		.int()
		.nonnegative()
		.optional()
		.describe(
			"Section number (0 = lead; 1..N = heading sections). Replaces that section's content, along with every subsection nested under it; see removeSubsections.",
		),
	mode: z
		.enum(['append', 'prepend'])
		.optional()
		.describe(
			"Adds source to the existing content instead of replacing it: 'append' to the end, 'prepend' to the start.",
		),
	bot: z
		.boolean()
		.optional()
		.describe(
			'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.',
		),
	removeSubsections: z
		.boolean()
		.optional()
		.describe(
			'Confirms that replacing this section is meant to remove the subsections nested under it. Required only when section is set and source contains fewer subsection headings than the section currently has.',
		),
} as const;

type UpdatePageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

function buildEditParams(
	ctx: ToolContext,
	{ title, source, latestId, comment, section, mode, bot }: UpdatePageArgs,
): Record<string, string | number | boolean> {
	const sourceField =
		mode === 'append' ? 'appendtext' : mode === 'prepend' ? 'prependtext' : 'text';
	const summary = formatEditComment(ctx, 'update-page', comment);
	return {
		action: 'edit',
		title,
		...(summary !== undefined ? { summary } : {}),
		nocreate: true,
		[sourceField]: source,
		...(latestId !== undefined ? { baserevid: latestId } : {}),
		...(section !== undefined ? { section: String(section) } : {}),
		...(bot === true ? { bot: true } : {}),
	};
}

// Replacing a section replaces everything nested under it. A source that brings
// the subsections back is not destructive; one that drops them deletes content
// the caller may never have read. Both sides of the comparison are parsed by
// the wiki itself, so what counts as a heading is decided once — a
// heading-shaped line inside <nowiki> or a comment is not a section on either
// side. Headings are counted rather than matched by text, so a rename passes.
async function subsectionRemovalError(
	args: UpdatePageArgs,
	ctx: ToolContext,
	mwn: Mwn,
): Promise<string | undefined> {
	const { section, source, mode, removeSubsections } = args;
	if (section === undefined || mode !== undefined || removeSubsections === true) {
		return undefined;
	}
	// The lead has no heading and cannot contain a subsection.
	if (section === 0) {
		return undefined;
	}
	const entries = await ctx.sections.list(mwn, args.title);
	const index = String(section);
	// childrenOf walks every entry so a transcluded heading still closes the
	// subtree at the right point; transcluded children are filtered out here
	// because they can never appear in source for the caller to carry back,
	// and the guard must not refuse a write over content it cannot supply.
	const children = childrenOf(entries, index).filter((c) => c.editable);
	if (children.length === 0) {
		return undefined;
	}
	const parent = entries.find((e) => e.index === index);
	if (parent === undefined) {
		return undefined;
	}
	// Sections a template in the source expands to carry `T-` ids and are
	// excluded, mirroring the transcluded-children filter above: only headings
	// the caller wrote count as carried back.
	const sourceSections = await ctx.sections.listInSource(mwn, args.title, source);
	const carriedBack = sourceSections.filter((e) => e.editable && e.level > parent.level).length;
	if (carriedBack >= children.length) {
		return undefined;
	}
	const names = children.map((c) => c.line).join(', ');
	return `Section ${index} (${parent.line}) contains ${children.length} subsection${children.length === 1 ? '' : 's'}: ${names}. The source supplied would remove them. Include them in source to keep them, or pass removeSubsections: true to remove them deliberately.`;
}

export const updatePage: Tool<typeof inputSchema> = {
	name: 'update-page',
	description:
		"Replaces the existing content of a wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. Pass latestId (obtained from get-page with metadata=true) to enable edit-conflict detection: if the page has been edited since that revision, the update is rejected rather than silently clobbering concurrent changes. For large pages, two modifiers avoid shipping the full source: section=N replaces one section together with every subsection nested under it, and is refused when source would drop those subsections; paired with get-page section=N it reads, changes and writes back a single section, which is also how to add content in the middle of a page; mode='append' or 'prepend' sends a delta, and adding a new section means appending a source that begins with a heading. Each call is a separate revision; for chains of mode='append' calls, re-fetching latestId between calls confirms the previous chunk landed before the next. Resending a mode='append' or 'prepend' call whose result never arrived adds the delta a second time.",
	inputSchema,
	annotations: {
		title: 'Update page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'update page',
	target: (a) => a.title,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const removalError = await subsectionRemovalError(args, ctx, mwn);
		if (removalError) {
			return ctx.format.invalidInput(removalError);
		}
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await ctx.edit.submit(mwn, buildEditParams(ctx, args))) as
				| { edit?: ApiEditResponse }
				| undefined;
		const edit = response?.edit;
		if (!edit || edit.result !== 'Success') {
			return ctx.format.error(
				'upstream_failure',
				`Failed to update page: ${JSON.stringify(edit ?? response)}`,
			);
		}
		const resolvedTitle = edit.title ?? args.title;
		return ctx.format.ok({
			pageId: edit.pageid,
			title: resolvedTitle,
			latestRevisionId: edit.newrevid,
			latestRevisionTimestamp: edit.newtimestamp,
			contentModel: edit.contentmodel,
			...(args.bot === true ? { botMarked: await ctx.edit.botRight(mwn) } : {}),
			url: await buildPageUrl(ctx, resolvedTitle),
		});
	},
};
