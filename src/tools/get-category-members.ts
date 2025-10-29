import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
import type { ApiQueryCategoryMembersParams } from 'types-mediawiki-api';
/* eslint-enable n/no-missing-import */
import type { ApiPageInfo } from '../types/mwn.ts';
import { getMwn } from '../common/mwn.js';

enum CategoryMemberType {
	file = 'file',
	page = 'page',
	subcat = 'subcat'
}

export function getCategoryMembersTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-category-members',
		'Gets all members in the category. Returns only page IDs, namespaces, and titles.',
		{
			category: z.string().describe( 'Category name' ),
			types: z.array( z.nativeEnum( CategoryMemberType ) ).describe( 'Types of members to include' ).optional(),
			namespaces: z.array( z.number().int() ).describe( 'Namespace IDs to filter by' ).optional()
		},
		{
			title: 'Get category members',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async (
			{ category, types, namespaces }
		) => handleGetCategoryMembersTool( category, types, namespaces )
	);
}

async function handleGetCategoryMembersTool(
	category: string, types?: CategoryMemberType[], namespaces?: number[]
): Promise< CallToolResult > {
	let data: ApiPageInfo[];
	try {
		const mwn = await getMwn();
		const mwnCategory = new mwn.Category( category );

		const options: ApiQueryCategoryMembersParams = {};

		if ( types ) {
			options.cmtype = types;
		}

		if ( namespaces ) {
			options.cmnamespace = namespaces;
		}

		data = await mwnCategory.members( options );
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Get category members failed: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}

	return {
		content: data.map( getCategoryMembersToolResult )
	};
}

function getCategoryMembersToolResult( result: ApiPageInfo ): TextContent {
	return {
		type: 'text',
		text: [
			`Page ID: ${ result.pageid }`,
			`Namespace: ${ result.ns }`,
			`Title: ${ result.title }`
		].join( '\n' )
	};
}
