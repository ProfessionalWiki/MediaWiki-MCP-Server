import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { instrumentToolCall } from './instrument.js';
import { removeMwnInstance } from '../common/mwn.js';
import { removeLicenseCache } from '../resources/index.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';
import { errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';
import type { Reconcile } from './reconcile.js';

export function removeWikiTool( server: McpServer, reconcile: Reconcile ): RegisteredTool {
	return server.registerTool(
		'remove-wiki',
		{
			description: 'Removes a wiki from the MCP resources. Clears any cached credentials and license metadata for the wiki. Fails if the specified wiki is currently active; call set-wiki to switch to a different wiki first.',
			inputSchema: {
				uri: z.string().describe( 'MCP resource URI of the wiki to remove (e.g. mcp://wikis/en.wikipedia.org)' )
			},
			annotations: {
				title: 'Remove wiki',
				readOnlyHint: false,
				destructiveHint: true,
				idempotentHint: true,
				openWorldHint: false
			} as ToolAnnotations
		},
		instrumentToolCall(
			'remove-wiki',
			async ( { uri } ) => handleRemoveWikiTool( server, reconcile, uri ),
			( a ) => a.uri
		)
	);
}

export async function handleRemoveWikiTool(
	server: McpServer,
	reconcile: Reconcile,
	uri: string
): Promise<CallToolResult> {
	try {
		const { wikiKey } = parseWikiResourceUri( uri );

		const wikiToRemove = wikiService.get( wikiKey );
		if ( !wikiToRemove ) {
			return errorResult( 'invalid_input', `mcp://wikis/${ wikiKey } not found in MCP resources` );
		}

		if ( wikiService.getCurrent().key === wikiKey ) {
			return errorResult(
				'conflict',
				'Cannot remove the currently active wiki. Please set a different wiki as the active wiki before removing this one.'
			);
		}

		wikiService.remove( wikiKey );
		server.sendResourceListChanged();
		removeMwnInstance( wikiKey );
		removeLicenseCache( wikiKey );
		reconcile();

		return structuredResult( {
			wikiKey,
			sitename: wikiToRemove.sitename,
			removed: true as const
		} );
	} catch ( error ) {
		if ( error instanceof InvalidWikiResourceUriError ) {
			return errorResult( 'invalid_input', error.message );
		}
		throw error;
	}
}
