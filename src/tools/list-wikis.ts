import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { SharedContext } from '../runtime/context.ts';
import { extensionPacks, packToolRefusal } from './extensions/index.ts';
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

export const listWikis: Tool<Record<string, never>, SharedContext> = {
	name: 'list-wikis',
	description:
		'Lists every configured wiki: its key (pass as the `wiki` argument to other tools), sitename, server URL, whether it is read-only or the default, whether it is currently reachable, and which extension-gated tools work on it. Use to discover the configured wikis, their keys, and which extension tools each supports.',
	inputSchema: {},
	annotations: {
		title: 'List wikis',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	wikiScoped: false,
	// Nothing to list when a single wiki is configured: every call defaults to it.
	offeredWhen: (c) => c.wikiCount >= 2,
	failureVerb: 'list wikis',

	async handle(_args, ctx: SharedContext): Promise<CallToolResult> {
		const defaultKey = ctx.defaultWikiKey;
		const all = ctx.wikis.getAll();
		const wikis: WikiSummary[] = await Promise.all(
			Object.keys(all).map(async (key): Promise<WikiSummary> => {
				const config = all[key];
				// The probe reads a public wiki anonymously, without resolving its
				// credentials, and reports the public server it last read.
				const identity = await ctx.wikiProbe.inspect(key);
				const { reachable } = identity;
				const publicServer = identity.server ?? config.server;
				const extensionTools = extensionPacks.flatMap((pack) =>
					pack.tools
						.filter((tool) => packToolRefusal(pack, tool.name, identity, key) === undefined)
						.map((tool) => tool.name),
				);
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
