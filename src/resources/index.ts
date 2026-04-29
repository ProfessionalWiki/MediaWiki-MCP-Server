import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../runtime/context.js';
import type { WikiConfig, PublicWikiConfig } from '../config/loadConfig.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.js';
import { licenseCache } from '../wikis/state.js';
import type { LicenseInfo } from '../wikis/licenseCache.js';

function sanitize(wikiConfig: Readonly<WikiConfig>): PublicWikiConfig {
	const { token: _token, username: _username, password: _password, ...publicConfig } = wikiConfig;
	return publicConfig;
}

async function getLicenseInfo(ctx: ToolContext, wikiKey: string): Promise<LicenseInfo | undefined> {
	const cached = licenseCache.get(wikiKey);
	if (cached) {
		return cached;
	}

	try {
		const mwn = await ctx.mwn(wikiKey);
		const response = await mwn.request({
			action: 'query',
			meta: 'siteinfo',
			siprop: 'rightsinfo',
			formatversion: '2',
		});

		const rightsInfo = response.query?.rightsinfo;
		if (rightsInfo?.url && rightsInfo.text) {
			const info: LicenseInfo = { url: rightsInfo.url, title: rightsInfo.text };
			licenseCache.set(wikiKey, info);
			return info;
		}
	} catch {
		// Graceful fallback if mwn is not initialized or the request fails.
	}
	return undefined;
}

export function registerAllResources(server: McpServer, ctx: ToolContext): void {
	const resourceTemplate = new ResourceTemplate(`${WIKI_RESOURCE_URI_PREFIX}{wikiKey}`, {
		list: () => {
			const allWikis = ctx.wikis.getAll();
			const resources: Resource[] = [];
			for (const wikiKey in allWikis) {
				const wikiConfig = allWikis[wikiKey];
				resources.push({
					uri: `${WIKI_RESOURCE_URI_PREFIX}${wikiKey}`,
					name: `wikis/${wikiKey}`,
					title: wikiConfig.sitename,
					description: `Wiki "${wikiConfig.sitename}" hosted at ${wikiConfig.server}`,
				});
			}
			return { resources };
		},
	});

	server.resource('wikis', resourceTemplate, async (uri, variables) => {
		const wikiKey = variables.wikiKey as string;
		const wikiConfig = ctx.wikis.get(wikiKey);

		if (!wikiConfig) {
			return { contents: [] };
		}

		const sanitized = sanitize(wikiConfig);
		const result: Record<string, unknown> = { ...sanitized };

		const license = await getLicenseInfo(ctx, wikiKey);
		if (license) {
			result.license = license;
		}

		return {
			contents: [
				{
					uri: uri.toString(),
					text: JSON.stringify(result, null, 2),
					mimeType: 'application/json',
				},
			],
		};
	});
}
