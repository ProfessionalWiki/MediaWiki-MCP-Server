import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { truncateByBytes } from '../results/truncation.js';

const DEFAULT_TITLE = 'API';

type CategoryItem = { category: string; hidden?: boolean };
type LinkItem = { title: string; exists?: boolean };

const inputSchema = {
	wikitext: z.string().min(1).describe('Wikitext to render'),
	title: z
		.string()
		.optional()
		.describe(
			'Wiki page title providing context for magic words like {{PAGENAME}}. Defaults to "API".',
		),
	applyPreSaveTransform: z
		.boolean()
		.optional()
		.default(true)
		.describe(
			'Apply pre-save transform (expand ~~~~ signatures, {{subst:}}, normalize whitespace). Matches editor "Show preview" behavior.',
		),
} as const;

export const parseWikitext: Tool<typeof inputSchema> = {
	name: 'parse-wikitext',
	description:
		'Renders wikitext through the live wiki without saving. Returns HTML, parse warnings, categories, wikilinks, templates, external URLs, and display title. Suited to dry-running a planned edit before create-page or update-page, or previewing standalone wikitext (template combinations, sanitizer checks) with no target page. HTML output is truncated at 50000 bytes with a trailing marker; a smaller wikitext fragment in a follow-up call returns the rest.',
	inputSchema,
	annotations: {
		title: 'Preview wikitext',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'preview wikitext',

	async handle(
		{ wikitext, title, applyPreSaveTransform },
		ctx: ToolContext,
	): Promise<CallToolResult> {
		const mwn = await ctx.mwn();
		const response = await mwn.request({
			action: 'parse',
			text: wikitext,
			title: title ?? DEFAULT_TITLE,
			pst: applyPreSaveTransform,
			prop: 'text|parsewarnings|categories|links|templates|externallinks|displaytitle',
			formatversion: '2',
		});

		const parse = response.parse ?? {};
		const html: string = parse.text ?? '';
		const truncated = truncateByBytes(html);

		const effectiveTitle = title ?? DEFAULT_TITLE;
		const displayTitle: string | undefined = parse.displaytitle;

		const warnings: string[] = Array.isArray(parse.parsewarnings) ? parse.parsewarnings : [];
		const categories: CategoryItem[] = Array.isArray(parse.categories) ? parse.categories : [];
		const links: LinkItem[] = Array.isArray(parse.links) ? parse.links : [];
		const templates: LinkItem[] = Array.isArray(parse.templates) ? parse.templates : [];
		const externalLinks: string[] = Array.isArray(parse.externallinks) ? parse.externallinks : [];

		const payload: Record<string, unknown> = { html: truncated.text };
		if (typeof displayTitle === 'string' && displayTitle !== effectiveTitle) {
			payload.displayTitle = displayTitle;
		}
		if (warnings.length > 0) {
			payload.parseWarnings = warnings;
		}
		if (categories.length > 0) {
			payload.categories = categories.map((c) => ({
				category: c.category,
				hidden: c.hidden,
			}));
		}
		if (links.length > 0) {
			payload.links = links.map((l) => ({
				title: l.title,
				exists: l.exists !== false,
			}));
		}
		if (templates.length > 0) {
			payload.templates = templates.map((t) => ({
				title: t.title,
				exists: t.exists !== false,
			}));
		}
		if (externalLinks.length > 0) {
			payload.externalLinks = externalLinks;
		}
		if (truncated.truncated) {
			payload.truncation = {
				reason: 'content-truncated',
				returnedBytes: truncated.returnedBytes,
				totalBytes: truncated.totalBytes,
				itemNoun: 'HTML',
				toolName: 'parse-wikitext',
				remedyHint: 'To avoid truncation, render a smaller wikitext fragment in a follow-up call.',
			};
		}

		return ctx.format.ok(payload);
	},
};
