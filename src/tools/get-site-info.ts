import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { resolveSiteInfo } from '../wikis/siteInfo.js';

const inputSchema = {
	includeStatistics: z
		.boolean()
		.optional()
		.describe(
			'Also return live wiki statistics (page, article, edit, image, user, active-user, and admin counts). Defaults to false.',
		),
} as const;

type GetSiteInfoArgs = z.infer<z.ZodObject<typeof inputSchema>>;

interface RawGeneral {
	sitename: string;
	generator: string;
	lang: string;
	case: string;
	readonly: boolean;
	readonlyreason?: string;
	maxarticlesize: number;
}

interface RawNamespace {
	id: number;
	name: string;
	canonical?: string;
	case?: string;
	content?: boolean;
}

interface RawNamespaceAlias {
	id: number;
	alias: string;
}

interface SiteInfoResponse {
	query?: {
		general?: RawGeneral;
		namespaces?: Record<string, RawNamespace>;
		namespacealiases?: RawNamespaceAlias[];
	};
}

interface Statistics {
	pages: number;
	articles: number;
	edits: number;
	images: number;
	users: number;
	activeusers: number;
	admins: number;
}

interface StatisticsResponse {
	query?: { statistics?: Partial<Statistics> };
}

function pickStatistics(raw: Partial<Statistics>): Statistics {
	return {
		pages: raw.pages ?? 0,
		articles: raw.articles ?? 0,
		edits: raw.edits ?? 0,
		images: raw.images ?? 0,
		users: raw.users ?? 0,
		activeusers: raw.activeusers ?? 0,
		admins: raw.admins ?? 0,
	};
}

interface CompactGeneral {
	sitename: string;
	generator: string;
	lang: string;
	case: string;
	readonly: boolean;
	readonlyreason?: string;
	maxarticlesize: number;
}

interface CompactNamespace {
	canonical: string;
	name: string;
	aliases?: string[];
	content?: boolean;
	case?: string;
}

function buildGeneral(g: RawGeneral): CompactGeneral {
	const general: CompactGeneral = {
		sitename: g.sitename,
		generator: g.generator,
		lang: g.lang,
		case: g.case,
		readonly: g.readonly,
		maxarticlesize: g.maxarticlesize,
	};
	if (g.readonly && typeof g.readonlyreason === 'string') {
		general.readonlyreason = g.readonlyreason;
	}
	return general;
}

function buildNamespaces(
	namespaces: Record<string, RawNamespace>,
	aliases: RawNamespaceAlias[],
	defaultCase: string,
): Record<string, CompactNamespace> {
	const aliasesById = new Map<number, string[]>();
	for (const a of aliases) {
		const list = aliasesById.get(a.id) ?? [];
		list.push(a.alias);
		aliasesById.set(a.id, list);
	}

	const out: Record<string, CompactNamespace> = {};
	for (const key of Object.keys(namespaces)) {
		const ns = namespaces[key];
		const entry: CompactNamespace = { canonical: ns.canonical ?? '', name: ns.name };
		const nsAliases = aliasesById.get(ns.id);
		if (nsAliases && nsAliases.length > 0) {
			entry.aliases = nsAliases;
		}
		if (ns.content === true) {
			entry.content = true;
		}
		if (typeof ns.case === 'string' && ns.case !== defaultCase) {
			entry.case = ns.case;
		}
		out[key] = entry;
	}
	return out;
}

export const getSiteInfo: Tool<typeof inputSchema> = {
	name: 'get-site-info',
	description:
		'Returns key facts about the targeted wiki from its MediaWiki siteinfo: general settings (sitename, MediaWiki version, content language, page-title case-sensitivity, live read-only state, and maxarticlesize in bytes), the namespace map with localized names and aliases, the list of installed extension names, and the content license. Set includeStatistics to also return page, article, edit, image, user, active-user, and admin counts.',
	inputSchema,
	annotations: {
		title: 'Get site info',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	failureVerb: 'fetch site info',

	async handle(args: GetSiteInfoArgs, ctx: ToolContext): Promise<CallToolResult> {
		const { key } = ctx.activeWiki.get();
		const mwn = await ctx.mwn();

		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
		const response = (await mwn.request({
			action: 'query',
			meta: 'siteinfo',
			siprop: 'general|namespaces|namespacealiases',
			formatversion: '2',
		})) as SiteInfoResponse;

		const query = response.query ?? {};
		const rawGeneral = query.general;
		if (!rawGeneral) {
			throw new Error('siteinfo response did not include general data');
		}
		const general = buildGeneral(rawGeneral);
		const namespaces = buildNamespaces(
			query.namespaces ?? {},
			query.namespacealiases ?? [],
			general.case,
		);

		const { extensions } = await ctx.extensions.inspect(key);
		const siteInfo = await resolveSiteInfo(ctx, key);

		const result: Record<string, unknown> = {
			general,
			namespaces,
			extensions: [...extensions].sort(),
		};
		if (siteInfo.license) {
			result.license = siteInfo.license;
		}

		if (args.includeStatistics === true) {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			const statsResponse = (await mwn.request({
				action: 'query',
				meta: 'siteinfo',
				siprop: 'statistics',
				formatversion: '2',
			})) as StatisticsResponse;
			result.statistics = pickStatistics(statsResponse.query?.statistics ?? {});
		}

		return ctx.format.ok(result);
	},
};
