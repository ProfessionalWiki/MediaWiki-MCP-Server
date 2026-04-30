import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import type { TruncationInfo } from '../results/truncation.js';

const DEFAULT_LIMIT = 50;
const MAX_LIMIT = 200;

const inputSchema = {
	search: z
		.string()
		.optional()
		.describe('Substring filter on property name (case-insensitive). Omit to list all properties.'),
	limit: z
		.number()
		.int()
		.min(1)
		.max(MAX_LIMIT)
		.optional()
		.describe('Maximum properties to return.'),
	continueFrom: z
		.string()
		.optional()
		.describe('Opaque continuation token from a previous response; omit on first call.'),
} as const;

// smwbrowse returns description and prefLabel as language-keyed objects
// ({ en: "..." }). usageCount comes back as a string. The query field is an
// object keyed by property key when there are matches, and an empty array
// when there are none.
interface SmwBrowseProperty {
	label?: string;
	key?: string;
	description?: Record<string, string>;
	prefLabel?: Record<string, string>;
	usageCount?: string | number;
}

interface SmwBrowseResponse {
	query?: Record<string, SmwBrowseProperty> | unknown[];
	'query-continue-offset'?: number;
}

interface NormalizedProperty {
	name: string;
	description?: string;
	usageCount?: number;
	usage: string;
}

export const smwListProperties: Tool<typeof inputSchema> = {
	name: 'smw-list-properties',
	description:
		'Lists Semantic MediaWiki properties on the active wiki. Each entry has the property name, a copy-paste `[[name::value]]` template for smw-ask, and — when SMW exposes them — a description and usage count. Wikis often have hundreds of properties; supply search to narrow. Up to 200 per call; paginate with continueFrom.',
	inputSchema,
	annotations: {
		title: 'List SMW properties',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'list SMW properties',

	async handle({ search, limit, continueFrom }, ctx: ToolContext): Promise<CallToolResult> {
		const offset = continueFrom !== undefined ? parsePositiveInt(continueFrom) : 0;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;

		const params = {
			search: search ?? '',
			limit: effectiveLimit,
			offset,
			description: true,
			prefLabel: true,
			usageCount: true,
		};

		const mwn = await ctx.mwn();
		const raw = await mwn.request({
			action: 'smwbrowse',
			browse: 'property',
			format: 'json',
			params: JSON.stringify(params),
		});
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- SMW action=smwbrowse response shape; trusted at this boundary
		const response = raw as SmwBrowseResponse;

		const properties: NormalizedProperty[] = [];
		const queryField = response.query;
		if (queryField && !Array.isArray(queryField)) {
			for (const [key, entry] of Object.entries(queryField)) {
				properties.push(normalizeProperty(key, entry));
			}
		}

		const continueOffset = response['query-continue-offset'];
		const truncation: TruncationInfo | null =
			typeof continueOffset === 'number' && continueOffset > 0
				? {
						reason: 'more-available',
						returnedCount: properties.length,
						itemNoun: 'properties',
						toolName: 'smw-list-properties',
						continueWith: { param: 'continueFrom', value: String(continueOffset) },
					}
				: null;

		return ctx.format.ok({
			properties,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

function normalizeProperty(key: string, raw: SmwBrowseProperty): NormalizedProperty {
	const name = raw.label ?? key.replaceAll('_', ' ');
	const out: NormalizedProperty = {
		name,
		usage: `[[${name}::value]]`,
	};

	const desc = pickFirstNonEmpty(raw.description);
	if (desc !== undefined) {
		out.description = desc;
	}

	const usageCount = parseUsageCount(raw.usageCount);
	if (usageCount !== undefined) {
		out.usageCount = usageCount;
	}

	return out;
}

function pickFirstNonEmpty(map: Record<string, string> | undefined): string | undefined {
	if (!map) {
		return undefined;
	}
	if (typeof map.en === 'string' && map.en !== '') {
		return map.en;
	}
	for (const value of Object.values(map)) {
		if (typeof value === 'string' && value !== '') {
			return value;
		}
	}
	return undefined;
}

function parseUsageCount(value: string | number | undefined): number | undefined {
	if (typeof value === 'number') {
		return Number.isFinite(value) && value >= 0 ? value : undefined;
	}
	if (typeof value !== 'string') {
		return undefined;
	}
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n >= 0 ? n : undefined;
}

function parsePositiveInt(value: string): number {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}
