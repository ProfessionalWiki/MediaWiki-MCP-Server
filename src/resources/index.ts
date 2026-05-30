import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from '../runtime/context.js';
import type { WikiConfig, PublicWikiConfig } from '../config/loadConfig.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.js';
import { resolveSiteInfo } from '../wikis/siteInfo.js';

function sanitize(wikiConfig: Readonly<WikiConfig>): PublicWikiConfig {
	const { token: _token, username: _username, password: _password, ...publicConfig } = wikiConfig;
	return publicConfig;
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
					// Cache read only — listing must not fan out a siteinfo fetch per
					// wiki, so the description shows the configured server until a
					// resource read warms the cache. The authoritative public server
					// is resolved in the content handler below.
					description: `Wiki "${wikiConfig.sitename}" hosted at ${ctx.siteInfoCache.get(wikiKey)?.server ?? wikiConfig.server}`,
				});
			}
			return { resources };
		},
	});

	server.resource('wikis', resourceTemplate, async (uri, variables) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP ResourceTemplate variables typed as string|string[]; URI template guarantees a single string
		const wikiKey = variables.wikiKey as string;
		const wikiConfig = ctx.wikis.get(wikiKey);

		if (!wikiConfig) {
			return { contents: [] };
		}

		const sanitized = sanitize(wikiConfig);
		const result: Record<string, unknown> = { ...sanitized };

		const siteInfo = await resolveSiteInfo(ctx, wikiKey);
		result.server = siteInfo.server;
		result.articlepath = siteInfo.articlepath;
		if (siteInfo.license) {
			result.license = siteInfo.license;
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
