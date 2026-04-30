import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { createTokenStore } from '../auth/tokenStore.js';

export const oauthStatus: Tool<Record<string, never>> = {
	name: 'oauth-status',
	description:
		'Lists wikis with stored OAuth tokens, their scopes, and expiry. Stdio only. Never returns token values.',
	inputSchema: {},
	annotations: {
		title: 'OAuth status',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false,
	} as ToolAnnotations,
	failureVerb: 'read OAuth status',

	async handle(_args, ctx: ToolContext): Promise<CallToolResult> {
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
