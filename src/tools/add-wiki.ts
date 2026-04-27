import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService, DuplicateWikiKeyError } from '../common/wikiService.js';
import { instrumentToolCall } from './instrument.js';
import { discoverWiki } from '../common/wikiDiscovery.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';
import { SsrfValidationError } from '../common/ssrfGuard.js';
import type { Reconcile } from './reconcile.js';

export function addWikiTool( server: McpServer, reconcile: Reconcile ): RegisteredTool {
	return server.registerTool(
		'add-wiki',
		{
			description: 'Registers a new wiki as an MCP resource by fetching its sitename and API configuration from any URL on the wiki (e.g. a page URL). The wiki becomes selectable via set-wiki at mcp://wikis/<servername>. Fails if the URL is not a MediaWiki wiki or if a wiki with the same key is already registered.',
			inputSchema: {
				wikiUrl: z.string().url().describe( 'Any URL from the target wiki (e.g. https://en.wikipedia.org/wiki/Main_Page)' )
			},
			annotations: {
				title: 'Add wiki',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		instrumentToolCall(
			'add-wiki',
			async ( { wikiUrl } ) => handleAddWikiTool( server, reconcile, wikiUrl ),
			( a ) => a.wikiUrl
		)
	);
}

export async function handleAddWikiTool(
	server: McpServer,
	reconcile: Reconcile,
	wikiUrl: string
): Promise<CallToolResult> {
	let wikiInfo;
	try {
		wikiInfo = await discoverWiki( wikiUrl );
	} catch ( error ) {
		if ( error instanceof SsrfValidationError ) {
			return errorResult( 'invalid_input', `Failed to add wiki: ${ error.message }` );
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to add wiki: ${ ( error as Error ).message }`, code );
	}

	if ( wikiInfo === null ) {
		return errorResult(
			'upstream_failure',
			'Failed to determine wiki info. Please ensure the URL is correct and the wiki is accessible.'
		);
	}

	try {
		const newConfig = {
			sitename: wikiInfo.sitename,
			server: wikiInfo.server,
			articlepath: wikiInfo.articlepath,
			scriptpath: wikiInfo.scriptpath,
			token: null,
			private: false
		};

		wikiService.add( wikiInfo.servername, newConfig );
		server.sendResourceListChanged();
		reconcile();

		return structuredResult( {
			wikiKey: wikiInfo.servername,
			sitename: wikiInfo.sitename,
			server: wikiInfo.server,
			articlepath: wikiInfo.articlepath,
			scriptpath: wikiInfo.scriptpath
		} );
	} catch ( error ) {
		if ( error instanceof DuplicateWikiKeyError ) {
			return errorResult( 'conflict', error.message );
		}
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to add wiki: ${ ( error as Error ).message }`, code );
	}
}
