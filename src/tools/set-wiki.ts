import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { instrumentToolCall } from './instrument.js';
import type { Reconcile } from './reconcile.js';
import { parseWikiResourceUri, InvalidWikiResourceUriError } from '../common/wikiResource.js';
import { errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function setWikiTool(
	server: McpServer,
	reconcile: Reconcile
): RegisteredTool {
	return server.registerTool(
		'set-wiki',
		{
			description: 'Selects the wiki to use for subsequent tool calls in this session. Required before interacting with a wiki that is not the configured default; the active wiki is consulted by every page, file, search, and history tool. Returns the new active wiki\'s sitename and server URL.',
			inputSchema: {
				uri: z.string().describe( 'MCP resource URI of the wiki to use (e.g. mcp://wikis/en.wikipedia.org)' )
			},
			annotations: {
				title: 'Set wiki',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: false
			} as ToolAnnotations
		},
		instrumentToolCall(
			'set-wiki',
			async ( { uri } ) => handleSetWikiTool( uri, reconcile )
		)
	);
}

export async function handleSetWikiTool(
	uri: string,
	reconcile: Reconcile
): Promise<CallToolResult> {
	try {
		const { wikiKey } = parseWikiResourceUri( uri );

		if ( !wikiService.get( wikiKey ) ) {
			return errorResult( 'invalid_input', `mcp://wikis/${ wikiKey } not found in MCP resources` );
		}

		wikiService.setCurrent( wikiKey );

		reconcile();
		const newConfig = wikiService.getCurrent().config;
		return structuredResult( {
			wikiKey,
			sitename: newConfig.sitename,
			server: newConfig.server
		} );
	} catch ( error ) {
		if ( error instanceof InvalidWikiResourceUriError ) {
			return errorResult( 'invalid_input', error.message );
		}
		throw error;
	}
}
