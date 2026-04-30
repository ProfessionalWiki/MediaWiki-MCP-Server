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

// SMW datatype codes → human-readable type names. The codes come from the
// "_xxx" series used internally by SMW. Codes not in this table fall through
// to the raw code so we never lie about the type.
const TYPE_LABELS: Record<string, string> = {
	_wpg: 'Page',
	_txt: 'Text',
	_str: 'String',
	_cod: 'Code',
	_num: 'Number',
	_qty: 'Quantity',
	_dat: 'Date',
	_boo: 'Boolean',
	_uri: 'URL',
	_eid: 'External identifier',
	_geo: 'Geographic coordinate',
	_tem: 'Temperature',
	_rec: 'Record',
	_mlt_rec: 'Monolingual text',
	_ref_rec: 'Reference',
	_anu: 'Annotation URI',
};

interface SmwBrowseProperty {
	label?: string;
	type?: string;
	description?: string;
	usageCount?: number;
}

interface SmwBrowseResponse {
	query?: SmwBrowseProperty[];
}

interface NormalizedProperty {
	name: string;
	type: string;
	description?: string;
	usageCount?: number;
	usage: string;
}

export const smwListProperties: Tool<typeof inputSchema> = {
	name: 'smw-list-properties',
	description:
		'Returns Semantic MediaWiki properties on the active wiki. Each entry includes the property name, datatype, optional description, usage count when available, and a copy-paste-ready [[name::value]] template for use in smw-ask. The wiki may have hundreds of properties; supply search to narrow.\n\nReturns up to 200 properties per call; paginate with continueFrom.',
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
		const mwn = await ctx.mwn();
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- smwbrowse response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'smwbrowse',
			browse: 'property',
			format: 'json',
		})) as SmwBrowseResponse;

		const all = (response.query ?? []).map(normalizeProperty);
		all.sort((a, b) => a.name.toLowerCase().localeCompare(b.name.toLowerCase()));

		const filtered = search
			? all.filter((p) => p.name.toLowerCase().includes(search.toLowerCase()))
			: all;

		const offset = continueFrom !== undefined ? parsePositiveInt(continueFrom) : 0;
		const effectiveLimit = limit ?? DEFAULT_LIMIT;
		const page = filtered.slice(offset, offset + effectiveLimit);

		const moreAvailable = offset + effectiveLimit < filtered.length;
		const truncation: TruncationInfo | null = moreAvailable
			? {
					reason: 'more-available',
					returnedCount: page.length,
					itemNoun: 'properties',
					toolName: 'smw-list-properties',
					continueWith: { param: 'continueFrom', value: String(offset + effectiveLimit) },
				}
			: null;

		return ctx.format.ok({
			properties: page,
			...(truncation !== null ? { truncation } : {}),
		});
	},
};

function normalizeProperty(raw: SmwBrowseProperty): NormalizedProperty {
	const name = raw.label ?? '';
	const typeCode = raw.type ?? '';
	const type = TYPE_LABELS[typeCode] ?? typeCode;
	const out: NormalizedProperty = {
		name,
		type,
		usage: `[[${name}::value]]`,
	};
	if (typeof raw.description === 'string' && raw.description !== '') {
		out.description = raw.description;
	}
	if (typeof raw.usageCount === 'number' && Number.isFinite(raw.usageCount)) {
		out.usageCount = raw.usageCount;
	}
	return out;
}

function parsePositiveInt(value: string): number {
	const n = Number.parseInt(value, 10);
	return Number.isFinite(n) && n >= 0 ? n : 0;
}
