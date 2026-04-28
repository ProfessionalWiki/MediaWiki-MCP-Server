import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from '../runtime/tool.js';
import type { ToolContext } from '../runtime/context.js';
import { getPageUrl, formatEditComment } from '../common/utils.js';

interface ApiEditResponse {
	result?: string;
	pageid?: number;
	title?: string;
	newrevid?: number;
	newtimestamp?: string;
	contentmodel?: string;
}

const inputSchema = {
	title: z.string().describe( 'Wiki page title' ),
	source: z.string().describe( 'The content to write, in the existing page\'s content model. Interpreted as the full page by default; as the given section\'s content when section is set; or as a delta (appended or prepended) when mode is set.' ),
	latestId: z.number().int().positive().optional().describe( 'Base revision ID for edit-conflict detection; obtain from get-page with metadata=true. If omitted, the update is applied without conflict detection.' ),
	comment: z.string().optional().describe( 'Summary of the edit' ),
	// eslint-disable-next-line es-x/no-set-prototype-union -- z.union, not Set.prototype.union
	section: z.union( [
		z.number().int().nonnegative(),
		z.literal( 'new' )
	] ).optional().describe( 'Section to edit: 0 (lead), 1..N (existing heading sections), or \'new\' to append a new heading section.' ),
	mode: z.enum( [ 'append', 'prepend' ] ).optional().describe( 'Adds source to the existing content instead of replacing it: \'append\' to the end, \'prepend\' to the start.' ),
	sectionTitle: z.string().optional().describe( 'Heading for a new section; required when section=\'new\', rejected otherwise.' )
} as const;

export const updatePage: Tool<typeof inputSchema> = {
	name: 'update-page',
	description: 'Replaces the existing content of a wiki page and returns the new revision ID. Fails if the page does not exist; for new pages, use create-page. Pass latestId (obtained from get-page with metadata=true) to enable edit-conflict detection: if the page has been edited since that revision, the update is rejected rather than silently clobbering concurrent changes. For large pages, three modifiers avoid shipping the full source: section=N edits one section (pairs with get-page section=N for reads), section=\'new\' adds a new heading section, and mode=\'append\' or \'prepend\' sends a delta. Each call is a separate revision; for chains of mode=\'append\' calls, re-fetching latestId between calls confirms the previous chunk landed before the next.',
	inputSchema,
	annotations: {
		title: 'Update page',
		readOnlyHint: false,
		destructiveHint: true,
		idempotentHint: true,
		openWorldHint: true
	} as ToolAnnotations,

	async handle(
		{ title, source, latestId, comment, section, mode, sectionTitle },
		ctx: ToolContext
	): Promise<CallToolResult> {
		if ( section === 'new' && mode !== undefined ) {
			return ctx.format.invalidInput( 'mode is not compatible with section=\'new\'' );
		}
		if ( section === 'new' && sectionTitle === undefined ) {
			return ctx.format.invalidInput( 'sectionTitle is required when section=\'new\'' );
		}
		if ( sectionTitle !== undefined && section !== 'new' ) {
			return ctx.format.invalidInput( 'sectionTitle is only valid when section=\'new\'' );
		}

		const mwn = await ctx.mwn();

		const params: Record<string, string | number | boolean> = {
			action: 'edit',
			title,
			summary: formatEditComment( 'update-page', comment ),
			nocreate: true
		};
		if ( mode === 'append' ) {
			params.appendtext = source;
		} else if ( mode === 'prepend' ) {
			params.prependtext = source;
		} else {
			params.text = source;
		}
		if ( latestId !== undefined ) {
			params.baserevid = latestId;
		}
		if ( section !== undefined ) {
			params.section = String( section );
		}
		if ( sectionTitle !== undefined ) {
			params.sectiontitle = sectionTitle;
		}

		const response = await ctx.edit.submit( mwn, params ) as
			{ edit?: ApiEditResponse } | undefined;
		const edit = response?.edit;

		if ( !edit || edit.result !== 'Success' ) {
			return ctx.format.error( 'upstream_failure', `Failed to update page: ${ JSON.stringify( edit ?? response ) }` );
		}

		const resolvedTitle = edit.title ?? title;
		return ctx.format.ok( {
			pageId: edit.pageid,
			title: resolvedTitle,
			latestRevisionId: edit.newrevid,
			latestRevisionTimestamp: edit.newtimestamp,
			contentModel: edit.contentmodel,
			url: getPageUrl( resolvedTitle )
		} );
	}
};
