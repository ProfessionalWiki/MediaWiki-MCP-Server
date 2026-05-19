import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { extensionPacks } from './extensions/index.js';
import { fetchMetadata } from '../auth/metadata.js';

interface WikiSummary {
	key: string;
	sitename: string;
	server: string;
	readOnly: boolean;
	isDefault: boolean;
	reachable: boolean;
	// Tool names from every extension pack the wiki supports; order is not significant.
	extensionTools: string[];
	// AS issuer for an OAuth-configured wiki; absent otherwise.
	authorizationServer?: string;
}

export const listWikis: Tool<Record<string, never>> = {
	name: 'list-wikis',
	description:
		'Lists every configured wiki: its key (pass as the `wiki` argument to other tools), sitename, server URL, whether it is read-only or the default, whether it is currently reachable, and which extension-gated tools (cargo-*, smw-*, bucket-query) work on it. Use to discover the configured wikis, their keys, and which extension tools each supports.',
	inputSchema: {},
	annotations: {
		title: 'List wikis',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	} as ToolAnnotations,
	wikiScoped: false,
	failureVerb: 'list wikis',

	async handle(_args, ctx: ToolContext): Promise<CallToolResult> {
		const defaultKey = ctx.activeWiki.getDefaultKey();
		const all = ctx.wikis.getAll();
		const wikis: WikiSummary[] = await Promise.all(
			Object.keys(all).map(async (key): Promise<WikiSummary> => {
				const config = all[key];
				const { reachable, extensions } = await ctx.extensions.inspect(key);
				const extensionTools: string[] = [];
				for (const pack of extensionPacks) {
					if (pack.extensionNames.some((name) => extensions.has(name))) {
						for (const tool of pack.tools) {
							extensionTools.push(tool.name);
						}
					}
				}
				let authorizationServer: string | undefined;
				if (typeof config.oauth2ClientId === 'string' && config.oauth2ClientId.trim() !== '') {
					try {
						const md = await fetchMetadata(key, {
							server: config.server,
							scriptpath: config.scriptpath,
						});
						authorizationServer = md.issuer;
					} catch {
						// Metadata unavailable — leave authorizationServer absent.
					}
				}
				return {
					key,
					sitename: config.sitename,
					server: config.server,
					readOnly: config.readOnly === true,
					isDefault: key === defaultKey,
					reachable,
					extensionTools,
					...(authorizationServer !== undefined ? { authorizationServer } : {}),
				};
			}),
		);
		return ctx.format.ok({ wikis });
	},
};
