import { z } from 'zod';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { createTokenStore } from '../auth/tokenStore.js';

const inputSchema = {
	wiki: z.string().optional().describe('Wiki key to log out from. Omit to log out from all wikis.'),
} as const;

export const oauthLogout: Tool<typeof inputSchema> = {
	name: 'oauth-logout',
	description:
		'Removes stored OAuth tokens. With no argument, removes all stored tokens; with `wiki`, removes only that wiki. Stdio only.',
	inputSchema,
	annotations: {
		title: 'OAuth logout',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: false,
	} as ToolAnnotations,
	failureVerb: 'log out',

	async handle({ wiki }, ctx: ToolContext): Promise<CallToolResult> {
		// Defense in depth: the reconcile rule already hides this tool on HTTP,
		// but a forced direct invocation must not delete from the local credentials file.
		if (ctx.transport !== 'stdio') {
			return ctx.format.invalidInput('oauth-logout is only available on the stdio transport.');
		}
		const store = createTokenStore();
		const cur = await store.read();
		const targets = typeof wiki === 'string' ? [wiki] : Object.keys(cur.tokens);
		const removed: string[] = [];
		for (const key of targets) {
			if (cur.tokens[key]) {
				await store.delete(key);
				removed.push(key);
				ctx.logger.info('', { event: 'oauth_token_revoked', wiki: key });
			}
		}
		return ctx.format.ok({ removed });
	},
};
