import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Mwn } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { getPageUrl } from '../common/utils.js';
import { ContentFormat } from '../common/contentFormat.js';
import {
	truncationMarker,
	truncateByBytes,
	type TruncationInfo
} from '../common/truncation.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-page',
		'Returns a single wiki page (wikitext source, rendered HTML, or metadata only). If the title does not exist, an error is returned. Use metadata=true to retrieve the revision ID (for edit-conflict detection), page size, and section outline. Set content="none" to fetch only metadata. Large content is truncated at 50000 bytes with a trailing marker listing available sections; a follow-up call with section=N fetches a specific section. For more than one page at a time, use get-pages. For a specific historical revision, use get-revision.',
		{
			title: z.string().describe( 'Wiki page title' ),
			content: z.nativeEnum( ContentFormat ).optional().default( ContentFormat.source ).describe( 'Type of content to return' ),
			metadata: z.boolean().optional().default( false ).describe(
				'Whether to include metadata (page ID, revision info, size, section outline) in the response'
			),
			section: z.number().int().nonnegative().optional().describe( 'Section number (0 = lead; 1..N = heading sections). Narrows content to one section.' )
		},
		{
			title: 'Get page',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( { title, content, metadata, section } ) => (
			handleGetPageTool( title, content, metadata, section )
		)
	);
}

interface PageSectionsApi {
	line?: string;
}

async function fetchSectionsList( mwn: Mwn, title: string ): Promise<string[]> {
	const response = await mwn.request( {
		action: 'parse',
		page: title,
		prop: 'sections',
		formatversion: '2'
	} );
	const apiSections: PageSectionsApi[] = response?.parse?.sections ?? [];
	// MediaWiki's prop=sections returns only heading sections; prepend a slot
	// for the lead so indices align with MediaWiki's rvsection convention
	// (0 = lead, 1..N = headings).
	return [ '', ...apiSections.map( ( s ) => s.line ?? '' ) ];
}

function formatSectionsBlock( sections: string[] ): string {
	const lines = sections.map( ( heading, index ) => {
		const label = index === 0 ? 'Lead' : heading;
		return `- ${ index }: ${ label }`;
	} );
	return `Sections:\n${ lines.join( '\n' ) }`;
}

function buildPageMetadata(
	page: { pageid: number; title: string },
	rev: { revid?: number; timestamp?: string; contentmodel?: string; size?: number } | undefined,
	sections: string[] | undefined
): TextContent {
	const lines = [
		`Page ID: ${ page.pageid }`,
		`Title: ${ page.title }`,
		`Latest revision ID: ${ rev?.revid }`,
		`Latest revision timestamp: ${ rev?.timestamp }`,
		`Content model: ${ rev?.contentmodel }`
	];
	if ( rev?.size !== undefined ) {
		lines.push( `Size: ${ rev.size }` );
	}
	if ( sections !== undefined ) {
		lines.push( formatSectionsBlock( sections ) );
	}
	lines.push( `HTML URL: ${ getPageUrl( page.title ) }` );
	return { type: 'text', text: lines.join( '\n' ) };
}

export async function handleGetPageTool(
	title: string,
	content: ContentFormat,
	metadata: boolean,
	section?: number
): Promise<CallToolResult> {
	if ( content === ContentFormat.none && !metadata ) {
		return {
			content: [ {
				type: 'text',
				text: 'When content is set to "none", metadata must be true'
			} ],
			isError: true
		};
	}
	if ( section !== undefined && content === ContentFormat.none ) {
		return {
			content: [ {
				type: 'text',
				text: 'section is not compatible with content="none"'
			} ],
			isError: true
		};
	}

	try {
		const mwn = await getMwn();
		const results: TextContent[] = [];

		const needsReadCall = metadata ||
			content === ContentFormat.source ||
			content === ContentFormat.none;
		const needsSource = content === ContentFormat.source;

		let sections: string[] | undefined;

		if ( needsReadCall ) {
			const rvprop = needsSource ?
				'ids|timestamp|contentmodel|size|content' :
				'ids|timestamp|contentmodel|size';
			const readParams: Record<string, string | number> = { rvprop };
			if ( needsSource && section !== undefined ) {
				readParams.rvsection = section;
			}
			const page = await mwn.read( title, readParams );

			if ( page.missing ) {
				return {
					content: [ {
						type: 'text',
						text: `Page "${ title }" not found`
					} as TextContent ],
					isError: true
				};
			}

			const rev = page.revisions?.[ 0 ];

			if ( metadata ) {
				sections = await fetchSectionsList( mwn, title );
			}

			if ( metadata || content === ContentFormat.none ) {
				results.push( buildPageMetadata( page, rev, sections ) );
			}

			if ( needsSource && rev?.content !== undefined ) {
				const truncated = truncateByBytes( rev.content );
				results.push( {
					type: 'text',
					text: metadata ? `Source:\n${ truncated.text }` : truncated.text
				} );
				if ( truncated.truncated ) {
					if ( sections === undefined ) {
						sections = await fetchSectionsList( mwn, title );
					}
					const info: TruncationInfo = {
						reason: 'content-truncated',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
						itemNoun: 'wikitext',
						toolName: 'get-page',
						sections,
						remedyHint: 'To read a specific section, call get-page again with section=N.'
					};
					results.push( truncationMarker( info ) );
				}
			}
		}

		if ( content === ContentFormat.html ) {
			const parseParams: Record<string, string | number> = {
				action: 'parse',
				page: title,
				prop: 'text',
				formatversion: '2'
			};
			if ( section !== undefined ) {
				parseParams.section = section;
			}
			const parseResult = await mwn.request( parseParams );
			const html: string | undefined = parseResult.parse?.text;
			const htmlSource = html ?? '';
			const truncated = truncateByBytes( htmlSource );

			if ( html === undefined ) {
				results.push( {
					type: 'text',
					text: metadata ? 'HTML:\nNot available' : 'Not available'
				} );
			} else {
				results.push( {
					type: 'text',
					text: metadata ? `HTML:\n${ truncated.text }` : truncated.text
				} );
				if ( truncated.truncated ) {
					if ( sections === undefined ) {
						sections = await fetchSectionsList( mwn, title );
					}
					const info: TruncationInfo = {
						reason: 'content-truncated',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
						itemNoun: 'HTML',
						toolName: 'get-page',
						sections,
						remedyHint: 'To read a specific section, call get-page again with section=N.'
					};
					results.push( truncationMarker( info ) );
				}
			}
		}

		return { content: results };
	} catch ( error ) {
		return {
			content: [
				{
					type: 'text',
					text: `Failed to retrieve page data: ${ ( error as Error ).message }`
				} as TextContent
			],
			isError: true
		};
	}
}
