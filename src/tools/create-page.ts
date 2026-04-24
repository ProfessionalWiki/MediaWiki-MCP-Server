import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiEditPageParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { wikiService } from '../common/wikiService.js';
import { getPageUrl, formatEditComment } from '../common/utils.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';
import { PageMetadataSchema } from '../common/schemas.js';

const outputSchema = PageMetadataSchema.shape;

export function createPageTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'create-page',
		{
			description: 'Creates a new wiki page with the provided content and returns the new page\'s title, page ID, and first revision ID. Fails if a page with the given title already exists; for existing pages, use update-page. The optional contentModel parameter selects a non-default content format (e.g. javascript, css); when omitted, MediaWiki picks the default for the title\'s namespace. For building up a large page across multiple calls, pair create-page with chained update-page(mode=\'append\') calls, each adding a chunk.',
			inputSchema: {
				source: z.string().describe( 'Page content in the format specified by the contentModel parameter' ),
				title: z.string().describe( 'Wiki page title' ),
				comment: z.string().optional().describe( 'Reason for creating the page' ),
				contentModel: z.string().optional().describe( 'Content model of the new page. If omitted, MediaWiki picks the default for the title\'s namespace.' )
			},
			outputSchema,
			annotations: {
				title: 'Create page',
				readOnlyHint: false,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async (
			{ source, title, comment, contentModel }
		) => handleCreatePageTool( source, title, comment, contentModel )
	);
}

export async function handleCreatePageTool(
	source: string,
	title: string,
	comment?: string,
	contentModel?: string
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();
		const options: ApiEditPageParams = {};
		if ( contentModel !== undefined ) {
			options.contentmodel = contentModel as ApiEditPageParams[ 'contentmodel' ];
		}
		const { config } = wikiService.getCurrent();
		if ( config.tags !== null && config.tags !== undefined ) {
			options.tags = config.tags;
		}
		const result = await mwn.create(
			title, source,
			formatEditComment( 'create-page', comment ),
			options
		);

		return structuredResult( {
			pageId: result.pageid,
			title: result.title,
			latestRevisionId: result.newrevid,
			latestRevisionTimestamp: result.newtimestamp,
			contentModel: result.contentmodel,
			url: getPageUrl( result.title )
		} );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to create page: ${ ( error as Error ).message }`, code );
	}
}
