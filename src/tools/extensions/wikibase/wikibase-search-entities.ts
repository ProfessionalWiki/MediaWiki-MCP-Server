import { z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../../../runtime/tool.ts';
import type { ToolContext } from '../../../runtime/context.ts';
import type { TruncationInfo } from '../../../results/truncation.ts';
import { LANGUAGE_CODE, resolveLanguage } from './wikibaseApi.ts';

const HARD_LIMIT = 50;
const DEFAULT_LIMIT = 10;

/** Property descriptions on large Wikibases run to whole paragraphs. */
const MAX_DESCRIPTION_CHARS = 200;

const inputSchema = {
	query: z
		.string()
		.min(1)
		.describe('Text matched against entity labels and aliases, as typed by a person.'),
	entityType: z
		.enum(['item', 'property'])
		.default('item')
		.describe('Which kind of entity to look for.'),
	language: z
		.string()
		.regex(LANGUAGE_CODE, 'A single language code, such as en or pt-br')
		.optional()
		.describe(
			'Language code the search terms and the returned labels are in. Defaults to the wiki content language.',
		),
	limit: z
		.number()
		.int()
		.min(1)
		.max(HARD_LIMIT)
		.default(DEFAULT_LIMIT)
		.describe('Maximum matches to return.'),
} as const;

interface SearchMatch {
	id?: string;
	label?: string;
	description?: string;
	datatype?: string;
	match?: { type?: string; text?: string };
}

export const wikibaseSearchEntities: Tool<typeof inputSchema> = {
	name: 'wikibase-search-entities',
	description:
		"Finds Wikibase items and properties by label or alias on the targeted wiki, returning one `id — label — description` line per match. Enabled only when the wiki is a Wikibase repository.\n\nEntity IDs are wiki-specific: the same concept has different Q-ids on Wikidata and on a private Wikibase, so IDs are discovered here rather than recalled. Properties carry their datatype in brackets, which tells wikibase-add-statement what a value for them looks like.\n\nMatching is prefix-and-alias based, not full-text: it finds entities whose name starts with the terms, not entities that mention them. To read an entity's statements, use wikibase-get-entity; to select entities by their statements, use wikibase-query.",
	inputSchema,
	annotations: {
		title: 'Search Wikibase entities',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	failureVerb: 'search Wikibase entities',
	target: (a) => a.query,

	async handle({ query, entityType, language, limit }, ctx: ToolContext): Promise<CallToolResult> {
		const searchLanguage = await resolveLanguage(ctx, language);
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbsearchentities response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'wbsearchentities',
			search: query,
			language: searchLanguage,
			uselang: searchLanguage,
			type: entityType,
			limit,
			format: 'json',
			formatversion: '2',
		})) as { search?: SearchMatch[]; 'search-continue'?: unknown };

		const matches = response.search ?? [];
		const results = matches.filter((match) => typeof match.id === 'string').map(renderMatch);

		// The API reports the offset it would resume from, which is the exact answer
		// to "were there more": a full page is not evidence of one.
		const truncation: TruncationInfo | null =
			typeof response['search-continue'] === 'number'
				? {
						reason: 'capped-no-continuation',
						returnedCount: results.length,
						limit,
						itemNoun: 'matches',
						narrowHint: `use more of the entity's name, or raise limit (max ${HARD_LIMIT}).`,
					}
				: null;

		return ctx.format.ok({
			results,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

function renderMatch(match: SearchMatch): string {
	const parts = [match.id, match.label].filter((part) => part !== undefined && part !== '');
	const description = clamp(match.description);
	if (description !== undefined) {
		parts.push(description);
	}
	let line = parts.join(' — ');
	if (match.datatype !== undefined) {
		line += ` [${match.datatype}]`;
	}
	// Naming the alias explains a match whose label looks unrelated to the query.
	if (match.match?.type === 'alias' && match.match.text !== undefined) {
		line += ` (matched alias: ${match.match.text})`;
	}
	return line;
}

function clamp(description: string | undefined): string | undefined {
	if (description === undefined || description === '') {
		return undefined;
	}
	return description.length > MAX_DESCRIPTION_CHARS
		? `${description.slice(0, MAX_DESCRIPTION_CHARS)}…`
		: description;
}
