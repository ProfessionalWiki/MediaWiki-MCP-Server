import { ResourceNotFoundError, ResourceTemplate } from '@modelcontextprotocol/server';
import type { McpServer, Resource } from '@modelcontextprotocol/server';
import type { ToolContext } from '../runtime/context.js';
import type { WikiConfig, PublicWikiConfig } from '../config/loadConfig.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../runtime/constants.js';
import { resolveSiteInfo } from '../wikis/siteInfo.js';
import { decodeWikiKey, encodeWikiKey } from '../runtime/wikiKey.js';

// Builds the published view of a wiki by naming the public fields, so a new
// WikiConfig field is private until someone adds it here. Credentials
// (`token`, `username`, `password`, `oauth2ClientSecret`) and server-side
// operational settings (`publicServer`, `oauth2CallbackPort`, `tags`,
// `attributeEdits`, `oauth2ClientId`) are all absent by construction.
// Undefined optional fields drop out of the JSON body, as before.
function toPublicConfig(wikiConfig: Readonly<WikiConfig>): PublicWikiConfig {
	return {
		sitename: wikiConfig.sitename,
		server: wikiConfig.server,
		articlepath: wikiConfig.articlepath,
		scriptpath: wikiConfig.scriptpath,
		private: wikiConfig.private,
		readOnly: wikiConfig.readOnly,
	};
}

export function registerAllResources(server: McpServer, ctx: ToolContext): void {
	const resourceTemplate = new ResourceTemplate(`${WIKI_RESOURCE_URI_PREFIX}{wikiKey}`, {
		list: () => {
			const allWikis = ctx.wikis.getAll();
			const resources: Resource[] = [];
			for (const wikiKey in allWikis) {
				const wikiConfig = allWikis[wikiKey];
				resources.push({
					uri: `${WIKI_RESOURCE_URI_PREFIX}${encodeWikiKey(wikiKey)}`,
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

	server.registerResource('wikis', resourceTemplate, {}, async (uri, variables) => {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- MCP ResourceTemplate variables typed as string|string[]; URI template guarantees a single string
		const matched = variables.wikiKey as string;
		// The SDK matches the template against the URI without percent-decoding.
		const wikiKey = decodeWikiKey(matched);

		if (wikiKey === undefined) {
			throw new ResourceNotFoundError(uri.toString());
		}

		const wikiConfig = ctx.wikis.get(wikiKey);

		if (!wikiConfig) {
			throw new ResourceNotFoundError(uri.toString());
		}

		const result: Record<string, unknown> = { ...toPublicConfig(wikiConfig) };

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
