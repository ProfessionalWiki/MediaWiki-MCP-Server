import { z, type ZodTypeAny } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import { SPECIAL_CONTENT_FIELD_NAMES, SPECIAL_CONTENT_KINDS } from './generated/fieldContract.ts';
import { DAY_DATE, ITEM_ID, LANGUAGE_CODE, resolveItemIdOrLabel } from './embeddableWrite.ts';
import {
	duplicateHitOf,
	duplicateHitResult,
	unresolvedWriteResult,
} from './embeddableAddOutcome.ts';

// The kind's field set is generated from the wiki's canonical contract
// (generated/fieldContract.ts); `satisfies` forces this validator table to
// cover every contract field exactly — a field added on the wiki and
// re-emitted fails compilation here until it is exposed or explicitly
// excluded in scripts/gen-embeddable-contract.cjs.
const FIELD_VALIDATORS = {
	label: z
		.string()
		.min(1)
		.max(250)
		.optional()
		.describe(
			'A short title for the item, e.g. "E = mc²" or the quotation\'s first words. Required when creating; on update it replaces the label in labelLanguage.',
		),
	content: z
		.string()
		.min(1)
		.optional()
		.describe(
			"The payload: the quotation text (quotation), LaTeX source (math — enclosing $…$, $$…$$, \\(…\\) or \\[…\\] delimiters are stripped on save), or the source code (code-snippet). Required when creating. Multi-line content is stored backslash-escaped (\\n, \\t, \\r, \\\\) because the wiki's string values reject the raw whitespace, and decoded at render time by the wiki. Content items carry no description field.",
		),
	note: z
		.string()
		.optional()
		.describe(
			'Accepted for kind=math only: an accompanying note rendered below the expression. Rich wikitext (links, media and $…$ math render); multi-line notes are stored backslash-escaped like the payload. Ignored for the other kinds.',
		),
	labelLanguage: z
		.string()
		.regex(LANGUAGE_CODE, 'A single lowercase language code, such as en or fr')
		.optional()
		.describe('Language code for the label. Defaults to en.'),
	language: z
		.string()
		.regex(LANGUAGE_CODE, 'A single lowercase language code, such as en or fr')
		.optional()
		.describe(
			'Language code of the quotation text. Accepted for kind=quotation only; ignored otherwise. Defaults to en.',
		),
	translations: z
		.string()
		.optional()
		.describe(
			'Accepted for kind=quotation only: added translations as a JSON array of {"language":"fr","content":"…"} rows (the AddQuotation "Add translation" field). The original stays in content/language. A blank language, a duplicate, a translation in the original language, or an invalid JSON shape is rejected by the wiki.',
		),
	programmingLanguage: z
		.string()
		.min(1)
		.optional()
		.describe(
			'Accepted for kind=code-snippet only: the programming language, as an item ID (Q57) or an English label resolved against the wiki\'s items (e.g. "Python").',
		),
	describes: z
		.string()
		.optional()
		.describe(
			'Accepted for kind=math only: comma/semicolon-separated item IDs (Q99) for the concepts the expression is about. Each element must be an item ID; any invalid element errors the call.',
		),
	implementationOf: z
		.string()
		.optional()
		.describe(
			'Accepted for kind=code-snippet only: comma/semicolon-separated item IDs for the algorithm or concept the code implements. Same strictness as describes.',
		),
	attributedTo: z
		.string()
		.regex(ITEM_ID, 'An item ID, such as Q94')
		.optional()
		.describe(
			'The person or work the content is attributed to. Required for quotations, optional otherwise.',
		),
	source: z
		.string()
		.regex(ITEM_ID, 'An item ID, such as Q96')
		.optional()
		.describe('The book or article this item is cited from, as an item ID.'),
	sourceUrl: z
		.string()
		.optional()
		.describe('The page or document this content comes from, as an http(s) URL.'),
	date: z
		.string()
		.regex(DAY_DATE, 'A calendar date in YYYY-MM-DD form')
		.optional()
		.describe('When the content was created or published, as YYYY-MM-DD at day precision.'),
} satisfies Record<(typeof SPECIAL_CONTENT_FIELD_NAMES)[number], ZodTypeAny>;

const inputSchema = {
	kind: z
		.enum(SPECIAL_CONTENT_KINDS)
		.describe(
			'What the item holds: quotation (a quote with language), math (LaTeX source), or code-snippet (source code).',
		),
	...FIELD_VALIDATORS,
	qid: z
		.string()
		.regex(ITEM_ID, 'An item ID, such as Q100')
		.optional()
		.describe(
			'Set to update an existing item instead of creating one. Managed statements (payload, provenance, subject fields) are replaced for fields provided here; blank fields keep the existing statements, and the class is never changed.',
		),
	confirmDuplicate: z
		.boolean()
		.optional()
		.describe(
			"Set true to create the item anyway when the wiki's duplication guard flags an existing item (the same authority id or URL, or a highly similar class-filtered label) as a duplicate of the record. The create is otherwise refused and the existing item returned instead. Forces the create; can produce a second item for the same content.",
		),
	comment: z.string().optional().describe('Edit summary, appended to the generated one.'),
} as const;

export const embeddableAddSpecialContent: Tool<typeof inputSchema> = {
	name: 'embeddable-add-special-content',
	description:
		"Creates or updates a quotation, mathematical expression or code-snippet item on a wiki with the EmbeddableContent extension, mirroring the Special:AddQuotation / AddMath / AddCodeSnippet forms, and returns the item ID and latest revision. Requires the edit right.\n\nThe item is created by the wiki's own special-content service (action=addspecialcontent): classified instance of the kind's class, payload handled exactly like the forms (math delimiters stripped, multi-line content backslash-escaped and decoded at render time), plus the provenance block you supply: attributedTo, source, sourceUrl and date. A quotation's content is stored as monolingual text in language, and attributedTo is required when creating one; its added translations ride in translations. A math item's note is an accompanying wikitext note. Content items carry no description field and create no classic page. A create that matches an existing item (the same authority id or URL, or a highly similar class-filtered label) is refused by the wiki's duplication guard, which returns the existing item instead of creating — update that item instead, or set confirmDuplicate to force the create. When the wiki's response is lost and no item comes back, the tool checks whether an item with the submitted label exists and reports the outcome before you retry. To find existing entities — including the attributedTo person or source item — use wikibase-search-entities first.\n\nSet qid to update an existing item instead: statements on the fields you provide are replaced, blank fields keep the existing statements, and the class is never changed. For the field table, property IDs and a ready-to-submit example, call embeddable-describe-entity-type first.",
	inputSchema,
	annotations: {
		title: 'Add special content',
		readOnlyHint: false,
		// Update mode replaces managed statements, so the tool can overwrite.
		destructiveHint: true,
		idempotentHint: false,
		openWorldHint: true,
	},
	failureVerb: 'add special content',
	target: (a) => a.qid ?? a.label ?? a.kind,

	async handle(args, ctx: ToolContext): Promise<CallToolResult> {
		const mwn = await ctx.mwn();

		// programmingLanguage accepts an item ID or an English label; resolve
		// a label to its Q-id here (the wiki module is entity-mode only).
		let programmingLanguage = args.programmingLanguage;
		if (args.programmingLanguage !== undefined && !/^[Qq]\d+$/.test(args.programmingLanguage)) {
			const resolved = await resolveItemIdOrLabel(ctx, args.programmingLanguage);
			if (resolved === undefined) {
				return ctx.format.invalidInput(
					`programmingLanguage "${args.programmingLanguage}" is neither an item ID nor an English label of an existing item.`,
				);
			}
			programmingLanguage = resolved;
		}

		// Every generated field is forwarded verbatim (the wiki validates); the
		// locally-resolved programmingLanguage overrides its label input.
		const params: Record<string, string> = {
			action: 'addspecialcontent',
			kind: args.kind,
		};
		for (const field of SPECIAL_CONTENT_FIELD_NAMES) {
			const value = field === 'programmingLanguage' ? programmingLanguage : args[field];
			if (value !== undefined && value !== '') {
				params[field] = value;
			}
		}
		if (args.qid !== undefined) {
			params.qid = args.qid.toUpperCase();
		}
		if (args.confirmDuplicate === true) {
			params.confirmDuplicate = '1';
		}
		if (args.comment !== undefined && args.comment !== '') {
			params.summary = args.comment;
		}

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=addspecialcontent response shape; trusted at this boundary
		const response = (await ctx.edit.submit(mwn, params)) as {
			content?: {
				entityId?: string;
				entityType?: string;
				latestRevisionId?: number;
				created?: boolean | string;
				updated?: boolean | string;
				duplicate?: boolean | string;
				duplicateOf?: string;
				duplicateLabel?: string;
				match?: string;
			};
		};

		const content = response?.content;
		if (content?.entityId === undefined) {
			// The wiki answered without creating: a duplication-guard refusal
			// names the existing item; anything else is a lost response whose
			// outcome is checked before the caller is told to retry.
			const duplicate = duplicateHitOf(content);
			if (duplicate !== undefined) {
				return duplicateHitResult(ctx, duplicate);
			}
			return unresolvedWriteResult(ctx, {
				noun: 'content item',
				mode: args.qid === undefined ? 'create' : 'update',
				label: args.label,
				qid: args.qid?.toUpperCase(),
				labelLanguage: args.labelLanguage,
			});
		}
		return ctx.format.ok({
			entityId: content.entityId,
			entityType: content.entityType,
			latestRevisionId: content.latestRevisionId,
			...(content.created === true || content.created === '1' ? { created: true } : {}),
			...(content.updated === true || content.updated === '1' ? { updated: true } : {}),
		});
	},
};
