import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';

const DEFAULT_TITLE = 'API';

export function parseWikitextTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'parse-wikitext',
		'Preview rendered wikitext without saving. Returns HTML, parse warnings, categories, links, templates, external links, and display title. Use this to verify sanitizer compliance, template expansion, and link resolution before committing an edit — or to test a wikitext combination that has no target page.',
		{
			wikitext: z.string().min( 1 ).describe( 'Wikitext source to render' ),
			title: z.string().optional().describe(
				'Page title context for magic words like {{PAGENAME}}. Defaults to "API".'
			),
			applyPreSaveTransform: z.boolean().optional().default( true ).describe(
				'Apply pre-save transform (expand ~~~~ signatures, {{subst:}}, normalize whitespace). Matches editor "Show preview" behavior.'
			)
		},
		{
			title: 'Preview wikitext',
			readOnlyHint: true,
			destructiveHint: false
		} as ToolAnnotations,
		async ( { wikitext, title, applyPreSaveTransform } ) =>
			handleParseWikitextTool( wikitext, title, applyPreSaveTransform )
	);
}

export async function handleParseWikitextTool(
	wikitext: string,
	title: string | undefined,
	applyPreSaveTransform: boolean
): Promise<CallToolResult> {
	try {
		const mwn = await getMwn();
		const response = await mwn.request( {
			action: 'parse',
			text: wikitext,
			title: title ?? DEFAULT_TITLE,
			pst: applyPreSaveTransform,
			prop: 'text|parsewarnings',
			formatversion: '2'
		} );

		const parse = response.parse ?? {};
		const results: TextContent[] = [];

		const warnings: string[] = Array.isArray( parse.parsewarnings ) ? parse.parsewarnings : [];
		if ( warnings.length > 0 ) {
			results.push( {
				type: 'text',
				text: `Parse warnings:\n${ warnings.map( ( w ) => `- ${ w }` ).join( '\n' ) }`
			} );
		}

		const html: string = parse.text ?? '';
		results.push( {
			type: 'text',
			text: `HTML:\n${ html }`
		} );

		return { content: results };
	} catch ( error ) {
		return {
			content: [ {
				type: 'text',
				text: `Failed to preview wikitext: ${ ( error as Error ).message }`
			} ],
			isError: true
		};
	}
}
