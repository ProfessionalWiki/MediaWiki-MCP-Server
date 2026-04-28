import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ManagementContext } from '../runtime/context.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../wikis/wikiResource.js';

const inputSchema = {
	uri: z.string().describe( 'MCP resource URI of the wiki to remove (e.g. mcp://wikis/en.wikipedia.org)' )
} as const;

export const removeWiki: Tool<typeof inputSchema, ManagementContext> = {
	name: 'remove-wiki',
	description: 'Removes a wiki from the MCP resources. Clears any cached credentials and license metadata for the wiki. Fails if the specified wiki is currently active; call set-wiki to switch to a different wiki first.',
	inputSchema,
	annotations: {
		title: 'Remove wiki',
		readOnlyHint: false,
		destructiveHint: true,
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

		const wikiToRemove = ctx.wikis.get( wikiKey );
		if ( !wikiToRemove ) {
			return ctx.format.invalidInput( `mcp://wikis/${ wikiKey } not found in MCP resources` );
		}

		if ( ctx.selection.getCurrent().key === wikiKey ) {
			return ctx.format.conflict(
				'Cannot remove the currently active wiki. Please set a different wiki as the active wiki before removing this one.'
			);
		}

		ctx.wikis.remove( wikiKey );
		ctx.wikiCache.invalidate( wikiKey );
		ctx.reconcile();

		return ctx.format.ok( {
			wikiKey,
			sitename: wikiToRemove.sitename,
			removed: true as const
		} );
	}
};
