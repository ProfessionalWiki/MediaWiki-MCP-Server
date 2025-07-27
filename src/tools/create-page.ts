import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { makeRestPostRequest, getPageUrl } from '../common/utils.js';
import { createPageLegacy } from '../common/legacy-api.js';
import type { MwRestApiPageObject } from '../types/mwRestApi.js';

export function createPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'create-page',
		'Creates a wiki page with the provided content.',
		{
			source: z.string().describe( 'Page content in the format specified by the contentModel parameter' ),
			title: z.string().describe( 'Wiki page title' ),
			comment: z.string().describe( 'Reason for creating the page' ).optional(),
			contentModel: z.string().describe( 'Type of content on the page. Defaults to "wikitext"' ).optional()
		},
		{
			title: 'Create page',
			readOnlyHint: false,
			destructiveHint: true
		} as ToolAnnotations,
		async (
			{ source, title, comment, contentModel }
		) => handleCreatePageTool( source, title, comment, contentModel )
	);
}

async function handleCreatePageTool(
	source: string,
	title: string,
	comment?: string,
	contentModel?: string
): Promise<CallToolResult> {
	let data: MwRestApiPageObject | null = null;

	try {
		// Try REST API first
		data = await makeRestPostRequest<MwRestApiPageObject>( '/v1/page', {
			source: source,
			title: title,
			comment: comment || '',
			// eslint-disable-next-line camelcase
			content_model: contentModel
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
				const legacyResult = await createPageLegacy( title, source, comment, contentModel );

				if ( legacyResult.success ) {
					return {
						content: [
							{
								type: 'text',
								text: `Page created successfully via legacy Action API: ${ getPageUrl( title ) }`
							},
							{
								type: 'text',
								text: [
									'Page created using legacy Action API fallback (OAuth 2.0 + REST API issue):',
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
							{ type: 'text', text: `Failed to create page via legacy API: ${ legacyResult.error }` } as TextContent
						],
						isError: true
					};
				}
			} catch ( legacyError ) {
				return {
					content: [
						{ type: 'text', text: `Failed to create page: REST API failed with token error and legacy API fallback also failed: ${ ( legacyError as Error ).message }` } as TextContent
					],
					isError: true
				};
			}
		}

		// For other REST API errors, return the original error
		return {
			content: [
				{ type: 'text', text: `Failed to create page: ${ ( error as Error ).message }` } as TextContent
			],
			isError: true
		};
	}

	if ( data === null ) {
		return {
			content: [
				{ type: 'text', text: 'Failed to create page: No data returned from API' } as TextContent
			],
			isError: true
		};
	}

	return {
		content: createPageToolResult( data )
	};
}

function createPageToolResult( result: MwRestApiPageObject ): TextContent[] {
	return [
		{
			type: 'text',
			text: `Page created successfully: ${ getPageUrl( result.title ) }`
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
