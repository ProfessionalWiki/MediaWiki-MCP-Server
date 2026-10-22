import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { sectionNotFound } from '../errors/tailoredErrors.ts';
import { formatEditComment } from '../wikis/utils.ts';
import { findReplaceSplice } from '../services/findReplace.ts';
import { submitPageEdit } from '../services/pageEdit.ts';
import { subsectionRemovalError } from '../services/subsectionGuard.ts';
import { unreadContentError } from '../services/unreadContentGuard.ts';

const OPERATIONS = ['replace', 'append', 'prepend', 'find-replace'] as const;
type Operation = (typeof OPERATIONS)[number];

// `section='new'` was removed; a caller sending it gets this instead of a bare
// type error naming a number. Delete this constant and the `error` function
// below once the release carrying that removal has shipped — see the Breaking
// changes entry in CHANGELOG.md.
const SECTION_NEW_REMOVED =
	'update-page no longer creates sections. To add one, use operation=\'append\' with a source that begins with the heading, for example "\\n\\n== History ==\\n\\nBody.".';

const inputSchema = {
	title: z.string().describe('Wiki page title'),
	operation: z
		.enum(OPERATIONS)
		.optional()
		.describe(
			"What the write does to the target: 'replace' overwrites it with source, 'append' and 'prepend' add source to it, and 'find-replace' rewrites only the text find names and leaves the rest of the target byte for byte. With section=N, 'append' writes at the end of that section and 'prepend' immediately above that section's heading, which inserts a new section before an existing one. Defaults to 'replace'.",
		),
	source: z
		.string()
		.optional()
		.describe(
			'The content to write, in the existing page\'s content model. Required for every operation except find-replace, and refused for that one. An appended source that opens a new section must begin on its own line, as in "\\n\\n== History ==\\n\\nBody."; without the leading newline the heading runs on from the last line of the page and is not recognised as a heading.',
		),
	find: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The existing wikitext to rewrite, matched in full and exactly, whitespace and template markup included. Required when operation is 'find-replace'. A find that matches nothing, or more than one place, is refused without writing: extend it with the text around it to name one occurrence.",
		),
	replaceWith: z
		.string()
		.optional()
		.describe(
			"What find becomes. Required when operation is 'find-replace'; an empty string deletes the text find matched.",
		),
	latestId: z
		.number()
		.int()
		.positive()
		.optional()
		.describe(
			'Base revision ID for edit-conflict detection; any get-page read that returns wikitext reports it as latestRevisionId. Required when section is set, because the wiki resolves a section number against this revision rather than against whichever is current. If omitted on a write that is not scoped to a section, the update is applied without conflict detection.',
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
			'Section number (0 = lead; 1..N = heading sections), from the section list get-page reports. Confines the write to that section: omit it to act on the whole page. A replace also takes out every subsection nested under the section; see removeSubsections.',
		),
	mode: z
		.enum(['append', 'prepend'])
		.optional()
		.describe(
			"Deprecated older spelling of operation='append' and operation='prepend'. Send operation instead.",
		),
	bot: z
		.boolean()
		.optional()
		.describe(
			'Marks the edit as a bot edit, which Special:RecentChanges hides by default. Takes effect only when the authenticated account has the `bot` right (granted by the bot group, or by the high-volume grant on a bot password or OAuth consumer); without it the edit saves unflagged and the response reports botMarked: false. Use when performing bulk or automated edit runs, or when the user requests it.',
		),
	removeUnreadContent: z
		.boolean()
		.optional()
		.describe(
			'Confirms that replacing content larger than a single read returns is meant to discard the part that was never returned. Required only when the target holds more bytes than one response carries and source holds fewer.',
		),
	removeSubsections: z
		.boolean()
		.optional()
		.describe(
			'Confirms that replacing this section is meant to remove the subsections nested under it. Required only when section is set and source contains fewer subsection headings than the section currently has.',
		),
} as const;

type UpdatePageArgs = z.infer<z.ZodObject<typeof inputSchema>>;

// The operation a call means, resolved once with the fields it needs already
// narrowed. `mode` is the older spelling of the same choice and stays accepted.
// Which fields an operation requires is a rule the flat schema cannot state —
// every field is independently optional — so it is stated here instead, and
// each refusal names both the field and the operation that decided it.
type WritePlan =
	| { readonly error: string }
	| { readonly operation: 'find-replace'; readonly find: string; readonly replaceWith: string }
	| { readonly operation: 'replace' | 'append' | 'prepend'; readonly source: string };

function writePlan(args: UpdatePageArgs): WritePlan {
	const { operation, mode, source, find, replaceWith, section, latestId } = args;
	if (operation !== undefined && mode !== undefined && operation !== mode) {
		return {
			error: `operation is '${operation}' but mode is '${mode}'. mode is the older spelling of the same choice; send operation alone.`,
		};
	}
	const resolved: Operation = operation ?? mode ?? 'replace';
	// A section number is only meaningful alongside the revision it was read
	// from: the wiki resolves it against whichever revision is current, so an
	// index that has since shifted addresses a different section. Required for a
	// replace alone, because that is where the mistake destroys the section it
	// lands on; a delta put in the wrong section is misplaced, not lost, and
	// shows in the diff. find-replace addresses its target by the text it
	// matches rather than by position, so it is unaffected either way. Section 0
	// is the lead, which no insertion can move, so there is no ambiguity to
	// resolve and nothing to require.
	if (resolved === 'replace' && section !== undefined && section > 0 && latestId === undefined) {
		return {
			error: `Section ${section} names a different section once the page changes, so replacing a section needs latestId to say which revision the number was read from. Any get-page read that returns wikitext reports it as latestRevisionId.`,
		};
	}
	if (resolved === 'find-replace') {
		if (find === undefined || replaceWith === undefined) {
			return {
				error:
					"operation 'find-replace' needs find, the existing wikitext to rewrite, and replaceWith, what it becomes.",
			};
		}
		if (source !== undefined) {
			return {
				error:
					"operation 'find-replace' rewrites only the text find matches, so it takes no source. To overwrite the whole target instead, send source with operation 'replace'.",
			};
		}
		return { operation: resolved, find, replaceWith };
	}
	if (source === undefined) {
		return { error: `operation '${resolved}' needs source, the content to write.` };
	}
	if (find !== undefined || replaceWith !== undefined) {
		return {
			error: `find and replaceWith belong to operation 'find-replace', not '${resolved}'.`,
		};
	}
	if (args.removeUnreadContent !== undefined && resolved !== 'replace') {
		return {
			error: `removeUnreadContent confirms a replace that discards content too large to have been read, so it applies only to operation 'replace', not '${resolved}'.`,
		};
	}
	if (
		args.removeSubsections !== undefined &&
		(resolved !== 'replace' || args.section === undefined)
	) {
		return {
			error:
				"removeSubsections confirms a section replace that drops the subsections nested under it, so it applies only to operation 'replace' with section set.",
		};
	}
	return { operation: resolved, source };
}

// Every write shares its title, summary, scope and flags; only the field
// carrying the content and the revision it is based on differ by operation.
function commonEditParams(
	ctx: ToolContext,
	{ title, comment, section, bot }: UpdatePageArgs,
): Record<string, string | number | boolean> {
	const summary = formatEditComment(ctx, 'update-page', comment);
	return {
		action: 'edit',
		title,
		...(summary !== undefined ? { summary } : {}),
		nocreate: true,
		...(section !== undefined ? { section: String(section) } : {}),
		...(bot === true ? { bot: true } : {}),
	};
}

function buildEditParams(
	ctx: ToolContext,
	args: UpdatePageArgs,
	plan: { operation: 'replace' | 'append' | 'prepend'; source: string },
): Record<string, string | number | boolean> {
	const sourceField =
		plan.operation === 'append'
			? 'appendtext'
			: plan.operation === 'prepend'
				? 'prependtext'
				: 'text';
	return {
		...commonEditParams(ctx, args),
		[sourceField]: plan.source,
		...(args.latestId !== undefined ? { baserevid: args.latestId } : {}),
	};
}

async function findReplace(
	args: UpdatePageArgs,
	plan: { find: string; replaceWith: string },
	ctx: ToolContext,
	mwn: Mwn,
): Promise<CallToolResult> {
	const splice = await findReplaceSplice(args, plan, ctx.format, mwn);
	if ('refusal' in splice) {
		return splice.refusal;
	}
	return submitPageEdit(
		ctx,
		mwn,
		'update page',
		{
			...commonEditParams(ctx, args),
			text: splice.text,
			...(splice.baseRevisionId !== undefined ? { baserevid: splice.baseRevisionId } : {}),
		},
		args,
	);
}

export const updatePage: Tool<typeof inputSchema> = {
	name: 'update-page',
	description:
		"Writes to an existing wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. operation says what the write does and section says where: omit section to act on the whole page, or set it to confine the write to one section. For changing part of a page, use operation='find-replace', which carries only the text being rewritten, so nothing outside find can be lost and the rest of the page never has to travel to or from the caller; a find that matches nothing, or more than one place, is refused without writing, which also makes it safe to resend a call whose result never arrived. For replacing a target outright, use operation='replace', whose source must carry every byte meant to survive; it is refused when source would shorten a target too large for one read to return whole, since the rest was never seen. With section set it also takes out every subsection nested under that section, is refused when source would drop them, and needs latestId to say which revision the section number was read from. operation='append' and 'prepend' add a delta: a new section at the end of the page is an append whose source begins with the heading, and with section set a prepend inserts one immediately above that section. Pass latestId (reported as latestRevisionId by any get-page read that returns wikitext) for edit-conflict detection: the write is rejected rather than silently clobbering a concurrent change. Each call is a separate revision, and resending an append or prepend whose result never arrived adds the delta a second time.",
	inputSchema,
	annotations: {
		title: 'Update page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'update page',
	tailoredErrors: { nosuchsection: sectionNotFound },
	target: (a) => a.title,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const plan = writePlan(args);
		if ('error' in plan) {
			return ctx.format.invalidInput(plan.error);
		}
		const mwn = await ctx.mwn();

		if (plan.operation === 'find-replace') {
			return findReplace(args, plan, ctx, mwn);
		}

		// Only a replace takes the section's subtree with it; a delta adds to the
		// section and removes nothing.
		if (plan.operation === 'replace') {
			// Before the subsection guard: a source that is a truncated prefix may
			// appear to drop subsections that simply lie past the cut, so that
			// guard's verdict on it would misdirect.
			const unreadError = await unreadContentError(args, plan.source, mwn);
			if (unreadError) {
				return ctx.format.invalidInput(unreadError);
			}
			const removalError = await subsectionRemovalError(args, plan.source, ctx.sections, mwn);
			if (removalError) {
				return ctx.format.invalidInput(removalError);
			}
		}
		return submitPageEdit(ctx, mwn, 'update page', buildEditParams(ctx, args, plan), args);
	},
};
