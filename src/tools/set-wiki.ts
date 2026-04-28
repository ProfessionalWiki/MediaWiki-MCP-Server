import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ManagementContext } from '../runtime/context.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';

const inputSchema = {
	uri: z.string().describe( 'MCP resource URI of the wiki to use (e.g. mcp://wikis/en.wikipedia.org)' )
} as const;

export const setWiki: Tool<typeof inputSchema, ManagementContext> = {
	name: 'set-wiki',
	description: 'Selects the wiki to use for subsequent tool calls in this session. Required before interacting with a wiki that is not the configured default; the active wiki is consulted by every page, file, search, and history tool. Returns the new active wiki\'s sitename and server URL.',
	inputSchema,
	annotations: {
		title: 'Set wiki',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: false
	} as ToolAnnotations,

	async handle( { uri }, ctx: ManagementContext ): Promise<CallToolResult> {
		let wikiKey: string;
		try {
			( { wikiKey } = parseWikiResourceUri( uri ) );
		} catch ( error ) {
			if ( error instanceof InvalidWikiResourceUriError ) {
				return ctx.format.invalidInput( error.message );
			}
			throw error;
		}

		if ( !ctx.wikis.get( wikiKey ) ) {
			return ctx.format.invalidInput( `mcp://wikis/${ wikiKey } not found in MCP resources` );
		}

		ctx.selection.setCurrent( wikiKey );
		ctx.reconcile();

		const newConfig = ctx.selection.getCurrent().config;
		return ctx.format.ok( {
			wikiKey,
			sitename: newConfig.sitename,
			server: newConfig.server
		} );
	}
};
