import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Mwn } from 'mwn';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { buildPageUrl, formatEditComment } from '../wikis/utils.ts';
import { contentMaxBytes } from '../results/truncation.ts';
import { editableChildrenOf } from '../services/sectionSubtree.ts';

const OPERATIONS = ['replace', 'append', 'prepend', 'find-replace'] as const;
type Operation = (typeof OPERATIONS)[number];

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

// Advances one character at a time, not by the needle's length: a needle that
// can begin inside its own previous match names two different splices, and
// String#split would report one. Self-overlapping strings are ordinary in
// wikitext — `}}\n}}`, `\n\n`, `==\n\n==`.
function occurrenceCount(haystack: string, needle: string): number {
	let count = 0;
	for (let at = haystack.indexOf(needle); at !== -1; at = haystack.indexOf(needle, at + 1)) {
		count++;
	}
	return count;
}

function scopeName(title: string, section: number | undefined): string {
	return section === undefined ? `page "${title}"` : `section ${section} of "${title}"`;
}

// Content larger than one response cannot have been read whole through this
// server, so a replace that shortens it is discarding bytes the caller never
// saw. That is the loss #536 records: a truncated read written straight back.
// Growth and same-size writes pass untouched, and a target inside the budget is
// never measured, because a caller could have read all of it.
async function unreadContentError(
	args: UpdatePageArgs,
	source: string,
	mwn: Mwn,
): Promise<string | undefined> {
	if (args.removeUnreadContent === true) {
		return undefined;
	}
	const cap = contentMaxBytes();
	// prop=info reports the page's byte length, and unlike mwn.read it resolves
	// no redirect, so it measures the page this write will land on.
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'info',
			titles: args.title,
			formatversion: '2',
		})) as { query?: { pages?: { length?: number }[] } } | undefined;
	const pageBytes = response?.query?.pages?.[0]?.length;
	// No section of a page inside the budget can be outside it either, so one
	// small request answers for both scopes in the ordinary case. A page the
	// wiki reports no length for is one it is about to refuse the edit on — a
	// missing or invalid title — and that error says more than this guard could,
	// so it is left to speak. A probe that throws propagates and no write
	// happens, as with the subsection guard.
	if (pageBytes === undefined || pageBytes <= cap) {
		return undefined;
	}
	const sourceBytes = Buffer.byteLength(source, 'utf8');
	if (args.section === undefined) {
		return sourceBytes < pageBytes
			? unreadContentMessage(`Page "${args.title}"`, pageBytes, sourceBytes, cap)
			: undefined;
	}
	// The write resolves the section number against latestId, so the guard has to
	// measure that same revision. Reading the current one certifies a section the
	// write will not touch: once a section has been inserted, section 2 of the
	// page now and section 2 of the base revision are different sections. Only
	// the lead reaches here without a base, and the lead cannot move.
	const sectionRead =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await mwn.request({
			action: 'query',
			prop: 'revisions',
			...(args.latestId === undefined ? { titles: args.title } : { revids: args.latestId }),
			rvprop: 'content',
			rvslots: 'main',
			rvsection: args.section,
			formatversion: '2',
		})) as
			| { query?: { pages?: { revisions?: { slots?: { main?: { content?: string } } }[] }[] } }
			| undefined;
	const current = sectionRead?.query?.pages?.[0]?.revisions?.[0]?.slots?.main?.content;
	// A section the revision does not have is the edit's own error to report.
	if (typeof current !== 'string') {
		return undefined;
	}
	const sectionBytes = Buffer.byteLength(current, 'utf8');
	if (sectionBytes <= cap || sourceBytes >= sectionBytes) {
		return undefined;
	}
	return unreadContentMessage(`Section ${args.section}`, sectionBytes, sourceBytes, cap);
}

function unreadContentMessage(
	target: string,
	targetBytes: number,
	sourceBytes: number,
	cap: number,
): string {
	return `${target} holds ${targetBytes} bytes, more than the ${cap} bytes one read returns, so the ${sourceBytes}-byte source supplied cannot contain all of it and this replace would delete the rest. To change part of it without resending it, use operation='find-replace'. To replace it with something shorter deliberately, pass removeUnreadContent: true.`;
}

// Replacing a section replaces everything nested under it. A source that brings
// the subsections back is not destructive; one that drops them deletes content
// the caller may never have read. Both sides of the comparison are parsed by
// the wiki itself, so what counts as a heading is decided once — a
// heading-shaped line inside <nowiki> or a comment is not a section on either
// side. Headings are counted rather than matched by text, so a rename passes.
async function subsectionRemovalError(
	args: UpdatePageArgs,
	source: string,
	ctx: ToolContext,
	mwn: Mwn,
): Promise<string | undefined> {
	const { section, removeSubsections } = args;
	if (section === undefined || removeSubsections === true) {
		return undefined;
	}
	// The lead has no heading and cannot contain a subsection.
	if (section === 0) {
		return undefined;
	}
	// Scoped to the revision the write names, for the same reason the size guard
	// is: the section numbers being compared are the ones the write resolves.
	const entries = await ctx.sections.list(mwn, args.title, args.latestId);
	const index = String(section);
	// The subtree walk counts every entry so a transcluded heading still closes
	// it at the right point; the transcluded children themselves drop out,
	// because the guard must not refuse a write over content the caller cannot
	// supply.
	const children = editableChildrenOf(entries, index);
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

// Submits a built edit and shapes the response. Shared by every operation, so
// one place decides what a successful write reports.
async function submitEdit(
	ctx: ToolContext,
	mwn: Mwn,
	params: Record<string, string | number | boolean>,
	args: UpdatePageArgs,
): Promise<CallToolResult> {
	const response =
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		(await ctx.edit.submit(mwn, params)) as { edit?: ApiEditResponse } | undefined;
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
}

// The server holds the target and the caller holds only the text it is
// changing, so the bytes the caller never sent are the bytes that cannot be
// lost. `find` is matched in full and exactly: a fuzzy or whitespace-tolerant
// match would change what a page means, since a single leading space turns a
// wikitext line into a `<pre>` block. The splice is by index rather than
// String#replace, which would read `$&` and `$1` in the replacement as
// references to the match.
async function findReplace(
	args: UpdatePageArgs,
	plan: { find: string; replaceWith: string },
	ctx: ToolContext,
	mwn: Mwn,
): Promise<CallToolResult> {
	const { title, section, latestId } = args;
	const { find, replaceWith } = plan;
	const readParams: Record<string, string | number | boolean> = {
		rvprop: 'ids|content',
		// mwn.read follows redirects by default, which would resolve the title to
		// the redirect's target while the edit below still goes to the title the
		// caller named — splicing the target's text over the redirect page and
		// leaving the target untouched.
		redirects: false,
	};
	if (section !== undefined) {
		readParams.rvsection = section;
	}
	const page = await mwn.read(title, readParams);
	if (page.missing) {
		return ctx.format.notFound(`Page "${title}" not found`);
	}
	if (page.invalid) {
		return ctx.format.invalidInput(`"${title}" is not a valid page title`);
	}
	const rev = page.revisions?.[0];
	const current = rev?.content;
	if (typeof current !== 'string') {
		// The API answers all three of these with a slot carrying no content
		// rather than with an error, so the tool has to tell them apart itself.
		if (section !== undefined) {
			// Matching what the dispatcher reports when the wiki raises this on a
			// write, so one condition does not have two names.
			return ctx.format.notFound(`Section ${section} does not exist`, 'nosuchsection');
		}
		// mwn's ApiRevision does not declare the flag MediaWiki sets on a revision
		// whose text is hidden, so it is read structurally.
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		if ((rev as { texthidden?: boolean } | undefined)?.texthidden === true) {
			return ctx.format.permissionDenied(
				`The current revision of "${title}" has its text hidden, so it cannot be read to edit`,
			);
		}
		return ctx.format.error('upstream_failure', `The wiki returned no content for "${title}"`);
	}
	// The anchor makes a splice tolerant of edits that did not touch it, so
	// latestId keeps the meaning it has everywhere else: the caller asked to be
	// refused if the page moved on at all.
	if (latestId !== undefined && rev?.revid !== latestId) {
		return ctx.format.conflict(
			`Page "${title}" is at revision ${rev?.revid}, not ${latestId}, so it has been edited since the revision named. Re-read it and send the edit again.`,
		);
	}

	const scope = scopeName(title, section);
	const occurrences = occurrenceCount(current, find);
	if (occurrences === 0) {
		// A retried call whose first attempt landed looks exactly like a bad
		// anchor, and saying so saves the caller a wasted retry. It is claimed
		// only when replaceWith is at least as specific as the find it replaced
		// and sits in the target exactly once, because a short replacement that
		// merely happens to occur would assert an edit that never happened —
		// the one direction of error that costs the caller its change.
		const applied =
			replaceWith.length >= find.length && occurrenceCount(current, replaceWith) === 1
				? ' The text replaceWith names is already present, so this edit may have landed already.'
				: '';
		return ctx.format.invalidInput(
			`No replacement was made: find did not appear in ${scope}.${applied} Read the current wikitext with get-page and copy find from it exactly, whitespace and template markup included.`,
		);
	}
	if (occurrences > 1) {
		return ctx.format.invalidInput(
			`No replacement was made: find appears ${occurrences} times in ${scope}. Extend find with the text around it so it names one occurrence${section === undefined ? ', or set section to search one section only' : ''}.`,
		);
	}

	const at = current.indexOf(find);
	const updated = current.slice(0, at) + replaceWith + current.slice(at + find.length);
	return submitEdit(
		ctx,
		mwn,
		{
			...commonEditParams(ctx, args),
			text: updated,
			// The base for this write is the revision the splice was computed
			// from, which is the one just read, never a revision the caller named.
			...(rev?.revid !== undefined ? { baserevid: rev.revid } : {}),
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
			const removalError = await subsectionRemovalError(args, plan.source, ctx, mwn);
			if (removalError) {
				return ctx.format.invalidInput(removalError);
			}
		}
		return submitEdit(ctx, mwn, buildEditParams(ctx, args, plan), args);
	},
};
