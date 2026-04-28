import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ManagementContext } from '../runtime/context.js';
import { discoverWiki } from '../wikis/wikiDiscovery.js';
import { SsrfValidationError } from '../transport/ssrfGuard.js';
import { DuplicateWikiKeyError } from '../wikis/wikiRegistry.js';

const inputSchema = {
	wikiUrl: z.string().url().describe( 'Any URL from the target wiki (e.g. https://en.wikipedia.org/wiki/Main_Page)' )
} as const;

export const addWiki: Tool<typeof inputSchema, ManagementContext> = {
	name: 'add-wiki',
	description: 'Registers a new wiki as an MCP resource by fetching its sitename and API configuration from any URL on the wiki (e.g. a page URL). The wiki becomes selectable via set-wiki at mcp://wikis/<servername>. Fails if the URL is not a MediaWiki wiki or if a wiki with the same key is already registered.',
	inputSchema,
	annotations: {
		title: 'Add wiki',
		readOnlyHint: false,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,
	failureVerb: 'add wiki',
	target: ( a ) => a.wikiUrl,

	async handle( { wikiUrl }, ctx: ManagementContext ): Promise<CallToolResult> {
		let wikiInfo;
		try {
			wikiInfo = await discoverWiki( wikiUrl );
		} catch ( error ) {
			if ( error instanceof SsrfValidationError ) {
				return ctx.format.invalidInput( `Failed to add wiki: ${ error.message }` );
			}
			throw error;
		}

		if ( wikiInfo === null ) {
			return ctx.format.error(
				'upstream_failure',
				'Failed to determine wiki info. Please ensure the URL is correct and the wiki is accessible.'
			);
		}

		try {
			ctx.wikis.add( wikiInfo.servername, {
				sitename: wikiInfo.sitename,
				server: wikiInfo.server,
				articlepath: wikiInfo.articlepath,
				scriptpath: wikiInfo.scriptpath,
				token: null,
				private: false
			} );
		} catch ( error ) {
			if ( error instanceof DuplicateWikiKeyError ) {
				return ctx.format.conflict( error.message );
			}
			throw error;
		}

		ctx.reconcile();

		return ctx.format.ok( {
			wikiKey: wikiInfo.servername,
			sitename: wikiInfo.sitename,
			server: wikiInfo.server,
			articlepath: wikiInfo.articlepath,
			scriptpath: wikiInfo.scriptpath
		} );
	}
};
