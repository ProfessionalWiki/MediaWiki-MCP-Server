import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPutRequest, getPageUrl } from '../common/utils.js';
import { updatePageLegacy } from '../common/legacy-api.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';

export function updatePageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'update-page',
		'Updates a wiki page. Replaces the existing content of a page with the provided content',
		{
			title: z.string().describe( 'Wiki page title' ),
			source: z.string().describe( 'Page content in the same content model of the existing page' ),
			latestId: z.number().describe( 'Identifier for the revision used as the base for the new source' ),
			comment: z.string().describe( 'Summary of the edit' ).optional()
		},
		{
			title: 'Update page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ title, source, latestId, comment }
		) => handleUpdatePageTool( title, source, latestId, comment )
	);
}

async function handleUpdatePageTool(
	title: string,
	source: string,
	latestId: number,
	comment?: string
): Promise<CallToolResult> {
	let data: MwRestApiPageObject | null = null;
	try {
		data = await makeRestPutRequest<MwRestApiPageObject>( `/v1/page/${ encodeURIComponent( title ) }`, {
			source: source,
			comment: comment,
			latest: { id: latestId }
		}, true );
	} catch ( error ) {
		// If REST API fails with OAuth + CSRF issues, try legacy Action API
		console.log( 'REST API error message:', ( error as Error ).message );
		const errorMessage = ( error as Error ).message;
		if ( errorMessage.includes( 'rest-badtoken' ) ||
			errorMessage.includes( 'CSRF' ) ||
			( errorMessage.includes( 'token' ) && errorMessage.includes( '403' ) ) ) {
			console.warn( 'REST API failed with CSRF/token error, attempting legacy Action API fallback...' );

			try {
				const legacyResult = await updatePageLegacy( title, source, comment, latestId );

				if ( legacyResult.success ) {
					return {
						content: [
							{
								type: 'text',
								text: `Page updated successfully via legacy Action API: ${ getPageUrl( title ) }`
							},
							{
								type: 'text',
								text: [
									'Page updated using legacy Action API fallback (OAuth 2.0 + REST API issue):',
									`Page ID: ${ legacyResult.pageid || 'Unknown' }`,
									`Title: ${ legacyResult.title || title }`,
									`New revision ID: ${ legacyResult.newrevid || 'Unknown' }`
								].join( '\n' )
							}
						]
					};
				} else {
					return {
						content: [
							{ type: 'text', text: `Failed to update page via legacy API: ${ legacyResult.error }` } as TextContent
						],
						isError: true
					};
				}
			} catch ( legacyError ) {
				return {
					content: [
						{ type: 'text', text: `Failed to update page: REST API failed with token error and legacy API fallback also failed: ${ ( legacyError as Error ).message }` } as TextContent
					],
					isError: true
				};
			}
		}

		// For other REST API errors, return the original error
		return {
			content: [
				{ type: 'text', text: `Failed to update page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	return {
		content: updatePageToolResult( data )
	};
}

function updatePageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page updated successfully: ${ getPageUrl( result.title ) }`
		},
		{
			type: 'text',
			text: [
				'Page object:',
				`Page ID: ${ result.id }`,
				`Title: ${ result.title }`,
				`Latest revision ID: ${ result.latest.id }`,
				`Latest revision timestamp: ${ result.latest.timestamp }`,
				`Content model: ${ result.content_model }`,
				`License: ${ result.license.url } ${ result.license.title }`,
				`HTML URL: ${ result.html_url }`
			].join( '\n' )
		}
	];
}
