import type { CallToolResult } from '@modelcontextprotocol/server';
import type { Tool } from '../runtime/tool.ts';
import type { SharedContext } from '../runtime/context.ts';
import { createTokenStore } from '../auth/tokenStore.ts';

export const oauthStatus: Tool<Record<string, never>, SharedContext> = {
	name: 'oauth-status',
	wikiScoped: false,
	offeredWhen: (c) => c.transport === 'stdio',
	description:
		'Lists wikis with stored OAuth tokens, their scopes, and expiry. Stdio only. Never returns token values.',
	inputSchema: {},
	annotations: {
		title: 'OAuth status',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	},
	failureVerb: 'read OAuth status',

	async handle(_args, ctx: SharedContext): Promise<CallToolResult> {
		// Defense in depth: offeredWhen already hides this tool on HTTP,
		// but a forced direct invocation must not read the local credentials file.
		if (ctx.auth.transport !== 'stdio') {
			return ctx.format.invalidInput('oauth-status is only available on the stdio transport.');
		}
		const store = await createTokenStore().read();
		const wikis = Object.entries(store.tokens).map(([wiki, t]) => ({
			wiki,
			scopes: t.scopes,
			expires_at: t.expires_at,
			obtained_at: t.obtained_at,
		}));
		return ctx.format.ok({ wikis });
	},
};
