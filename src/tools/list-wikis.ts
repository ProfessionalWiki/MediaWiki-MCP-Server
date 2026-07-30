import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { ToolContext } from '../runtime/context.ts';
import { extensionPacks } from './extensions/index.ts';
import { bearerPassthroughEnabled } from '../runtime/authShape.ts';
import { fetchMetadata } from '../auth/metadata.ts';

interface WikiSummary {
	key: string;
	sitename: string;
	server: string;
	readOnly: boolean;
	isDefault: boolean;
	reachable: boolean;
	// Tool names from every extension pack the wiki supports; order is not significant.
	extensionTools: string[];
	// Where a caller obtains a token for this wiki. Reported only while forwarding a
	// caller-supplied token is enabled, since that is the only shape in which the
	// answer is actionable: otherwise the server refuses such a token, and pointing
	// at the issuer would send a client to mint one it cannot use.
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
	},
	wikiScoped: false,
	failureVerb: 'list wikis',

	async handle(_args, ctx: ToolContext): Promise<CallToolResult> {
		const defaultKey = ctx.activeWiki.getDefaultKey();
		const all = ctx.wikis.getAll();
		const wikis: WikiSummary[] = await Promise.all(
			Object.keys(all).map(async (key): Promise<WikiSummary> => {
				const config = all[key];
				// Discovery reads only the anonymous probe — no credential
				// resolution or login. The probe reports the wiki's live public
				// server; fall back to the configured server when it is unreachable.
				const { reachable, extensions, server } = await ctx.wikiProbe.inspect(key);
				const publicServer = server ?? config.server;
				const extensionTools: string[] = [];
				for (const pack of extensionPacks) {
					if (pack.extensionNames.some((name) => extensions.has(name))) {
						for (const tool of pack.tools) {
							extensionTools.push(tool.name);
						}
					}
				}
				let authorizationServer: string | undefined;
				if (
					bearerPassthroughEnabled() &&
					typeof config.oauth2ClientId === 'string' &&
					config.oauth2ClientId.trim() !== ''
				) {
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
					server: publicServer,
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
