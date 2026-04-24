import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import {
	truncationMarker,
	truncateByBytes
} from '../common/truncation.js';

const DEFAULT_TITLE = 'API';

type CategoryItem = { category: string; hidden?: boolean };
type LinkItem = { title: string; exists?: boolean };

function formatCategory( item: CategoryItem ): string {
	const suffix = item.hidden ? ' (hidden)' : '';
	return `- Category:${ item.category }${ suffix }`;
}

function formatLinkLike( item: LinkItem ): string {
	const suffix = item.exists === false ? ' (missing)' : '';
	return `- ${ item.title }${ suffix }`;
}

function bulletSection( header: string, lines: string[] ): TextContent | null {
	if ( lines.length === 0 ) {
		return null;
	}
	return {
		type: 'text',
		text: `${ header }:\n${ lines.join( '\n' ) }`
	};
}

export function parseWikitextTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'parse-wikitext',
		'Renders wikitext through the live wiki without saving. Returns HTML, parse warnings, categories, wikilinks, templates, external URLs, and display title. Suited to dry-running a planned edit before create-page or update-page, or previewing standalone wikitext (template combinations, sanitizer checks) with no target page. HTML output is truncated at 50000 bytes with a trailing marker; a smaller wikitext fragment in a follow-up call returns the rest.',
		{
			wikitext: z.string().min( 1 ).describe( 'Wikitext to render' ),
			title: z.string().optional().describe(
				'Wiki page title providing context for magic words like {{PAGENAME}}. Defaults to "API".'
			),
			applyPreSaveTransform: z.boolean().optional().default( true ).describe(
				'Apply pre-save transform (expand ~~~~ signatures, {{subst:}}, normalize whitespace). Matches editor "Show preview" behavior.'
			)
		},
		{
			title: 'Preview wikitext',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( { wikitext, title, applyPreSaveTransform } ) => (
			handleParseWikitextTool( wikitext, title, applyPreSaveTransform )
		)
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
			prop: 'text|parsewarnings|categories|links|templates|externallinks|displaytitle',
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
		const truncated = truncateByBytes( html );
		results.push( {
			type: 'text',
			text: `HTML:\n${ truncated.text }`
		} );
		if ( truncated.truncated ) {
			results.push( truncationMarker( {
				reason: 'content-truncated',
				returnedBytes: truncated.returnedBytes,
				totalBytes: truncated.totalBytes,
				itemNoun: 'HTML',
				toolName: 'parse-wikitext',
				remedyHint: 'To avoid truncation, render a smaller wikitext fragment in a follow-up call.'
			} ) );
		}

		const effectiveTitle = title ?? DEFAULT_TITLE;
		const displayTitle: string | undefined = parse.displaytitle;
		if ( typeof displayTitle === 'string' && displayTitle !== effectiveTitle ) {
			results.push( {
				type: 'text',
				text: `Display title: ${ displayTitle }`
			} );
		}

		const categories: CategoryItem[] = Array.isArray( parse.categories ) ?
			parse.categories : [];
		const categoriesBlock = bulletSection( 'Categories', categories.map( formatCategory ) );
		if ( categoriesBlock ) {
			results.push( categoriesBlock );
		}

		const links: LinkItem[] = Array.isArray( parse.links ) ? parse.links : [];
		const linksBlock = bulletSection( 'Links', links.map( formatLinkLike ) );
		if ( linksBlock ) {
			results.push( linksBlock );
		}

		const templates: LinkItem[] = Array.isArray( parse.templates ) ? parse.templates : [];
		const templatesBlock = bulletSection( 'Templates', templates.map( formatLinkLike ) );
		if ( templatesBlock ) {
			results.push( templatesBlock );
		}

		const externallinks: string[] = Array.isArray( parse.externallinks ) ?
			parse.externallinks : [];
		const externalsBlock = bulletSection(
			'External links',
			externallinks.map( ( url ) => `- ${ url }` )
		);
		if ( externalsBlock ) {
			results.push( externalsBlock );
		}

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
