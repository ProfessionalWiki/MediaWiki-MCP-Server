import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Mwn } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { getPageUrl } from '../common/utils.js';
import { ContentFormat } from '../common/contentFormat.js';
import {
	truncateByBytes,
	type TruncationInfo
} from '../common/truncation.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

export function getPageTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'get-page',
		{
			description: 'Returns a single wiki page (wikitext source, rendered HTML, or metadata only). If the title does not exist, an error is returned. Use metadata=true to retrieve the revision ID (for edit-conflict detection), page size, and section outline. Set content="none" to fetch only metadata. Large content is truncated at 50000 bytes with a trailing marker listing available sections; a follow-up call with section=N fetches a specific section. For more than one page at a time, use get-pages. For a specific historical revision, use get-revision.',
			inputSchema: {
				title: z.string().describe( 'Wiki page title' ),
				content: z.nativeEnum( ContentFormat ).optional().default( ContentFormat.source ).describe( 'Type of content to return' ),
				metadata: z.boolean().optional().default( false ).describe(
					'Whether to include metadata (page ID, revision info, size, section outline) in the response'
				),
				section: z.number().int().nonnegative().optional().describe( 'Section number (0 = lead; 1..N = heading sections). Narrows content to one section.' )
			},
			annotations: {
				title: 'Get page',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
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

export async function handleGetPageTool(
	title: string,
	content: ContentFormat,
	metadata: boolean,
	section?: number
): Promise<CallToolResult> {
	if ( content === ContentFormat.none && !metadata ) {
		return errorResult( 'invalid_input', 'When content is set to "none", metadata must be true' );
	}
	if ( section !== undefined && content === ContentFormat.none ) {
		return errorResult( 'invalid_input', 'section is not compatible with content="none"' );
	}

	try {
		const mwn = await getMwn();

		const payload: {
			pageId?: number;
			title?: string;
			latestRevisionId?: number;
			latestRevisionTimestamp?: string;
			contentModel?: string;
			size?: number;
			url?: string;
			sections?: string[];
			source?: string;
			html?: string;
			truncation?: TruncationInfo;
		} = {};

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
				return errorResult( 'not_found', `Page "${ title }" not found` );
			}

			const rev = page.revisions?.[ 0 ];

			if ( metadata ) {
				sections = await fetchSectionsList( mwn, title );
			}

			if ( metadata || content === ContentFormat.none ) {
				payload.pageId = page.pageid;
				payload.title = page.title;
				payload.latestRevisionId = rev?.revid;
				payload.latestRevisionTimestamp = rev?.timestamp;
				payload.contentModel = rev?.contentmodel;
				if ( rev?.size !== undefined ) {
					payload.size = rev.size;
				}
				if ( sections !== undefined ) {
					payload.sections = sections;
				}
				payload.url = getPageUrl( page.title );
			}

			if ( needsSource && rev?.content !== undefined ) {
				const truncated = truncateByBytes( rev.content );
				payload.source = truncated.text;
				if ( truncated.truncated ) {
					if ( sections === undefined ) {
						sections = await fetchSectionsList( mwn, title );
					}
					payload.truncation = {
						reason: 'content-truncated',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
						itemNoun: 'wikitext',
						toolName: 'get-page',
						sections,
						remedyHint: 'To read a specific section, call get-page again with section=N.'
					};
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

			if ( html !== undefined ) {
				const truncated = truncateByBytes( html );
				payload.html = truncated.text;

				if ( payload.title === undefined ) {
					const resolvedTitle: string = parseResult.parse?.title ?? title;
					payload.title = resolvedTitle;
					if ( parseResult.parse?.pageid !== undefined ) {
						payload.pageId = parseResult.parse.pageid;
					}
					payload.url = getPageUrl( resolvedTitle );
				}

				if ( truncated.truncated ) {
					if ( sections === undefined ) {
						sections = await fetchSectionsList( mwn, title );
					}
					payload.truncation = {
						reason: 'content-truncated',
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes,
						itemNoun: 'HTML',
						toolName: 'get-page',
						sections,
						remedyHint: 'To read a specific section, call get-page again with section=N.'
					};
				}
			}
		}

		return structuredResult( payload );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve page data: ${ ( error as Error ).message }`, code );
	}
}
