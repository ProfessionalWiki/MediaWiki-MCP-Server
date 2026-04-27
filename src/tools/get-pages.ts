import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Mwn } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { getPageUrl } from '../common/utils.js';
import { instrumentToolCall } from './instrument.js';
import {
	truncateByBytes,
	type TruncationInfo
} from '../common/truncation.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

const MAX_TITLES = 50;

export enum BatchContentFormat {
	source = 'source',
	none = 'none'
}

interface PageEntry {
	requestedTitle: string;
	pageId?: number;
	title?: string;
	redirectedFrom?: string;
	latestRevisionId?: number;
	latestRevisionTimestamp?: string;
	contentModel?: string;
	url?: string;
	source?: string;
	truncation?: TruncationInfo;
}

export function getPagesTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'get-pages',
		{
			description: `Returns multiple wiki pages in one call (wikitext source or metadata only). Suited to reading a cluster of related pages, diffing a page family, or syncing pages to local storage. Accepts up to ${ MAX_TITLES } titles; missing pages are reported inline (not as errors). Each page's content is truncated at 50000 bytes with a trailing marker listing available sections; get-page with section=N fetches a specific section. For a single page or HTML output, use get-page.`,
			inputSchema: {
				titles: z.array( z.string() ).describe( `Array of wiki page titles (1..${ MAX_TITLES })` ),
				content: z.nativeEnum( BatchContentFormat ).optional().default( BatchContentFormat.source ).describe( 'Type of content to return; "none" returns metadata only' ),
				metadata: z.boolean().optional().default( false ).describe( 'Whether to include metadata (page ID, revision info) in the response' ),
				followRedirects: z.boolean().optional().default( true ).describe( 'Follow wiki redirects. When true (default), redirect targets are returned with a "Redirected from:" line in the metadata. Set false to fetch redirect pseudo-pages as-is (sync-fidelity).' )
			},
			annotations: {
				title: 'Get pages',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		instrumentToolCall(
			'get-pages',
			async ( { titles, content, metadata, followRedirects } ) => handleGetPagesTool(
				titles, content, metadata, followRedirects
			)
		)
	);
}

interface PageRev {
	revid?: number;
	timestamp?: string;
	contentmodel?: string;
	content?: string;
	slots?: {
		main?: { contentmodel?: string; content?: string };
	};
}

interface ApiPageLike {
	pageid: number;
	title: string;
	missing?: boolean;
	revisions?: PageRev[];
}

interface RedirectOrNormalizedEntry {
	from: string;
	to: string;
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
	return [ '', ...apiSections.map( ( s ) => s.line ?? '' ) ];
}

function resolveChain(
	requested: string,
	aliasTo: Map<string, string>,
	redirectFrom: Set<string>
): { resolved: string; viaRedirect: boolean } {
	let cur = requested;
	let viaRedirect = false;
	const seen = new Set<string>();
	while ( aliasTo.has( cur ) && !seen.has( cur ) ) {
		seen.add( cur );
		if ( redirectFrom.has( cur ) ) {
			viaRedirect = true;
		}
		cur = aliasTo.get( cur )!;
	}
	return { resolved: cur, viaRedirect };
}

export async function handleGetPagesTool(
	titles: string[],
	content: BatchContentFormat,
	metadata: boolean,
	followRedirects: boolean = true
): Promise<CallToolResult> {
	if ( titles.length === 0 ) {
		return errorResult( 'invalid_input', 'titles must contain at least one entry' );
	}
	if ( titles.length > MAX_TITLES ) {
		return errorResult( 'invalid_input', `titles must contain at most ${ MAX_TITLES } entries` );
	}
	if ( content === BatchContentFormat.none && !metadata ) {
		return errorResult( 'invalid_input', 'When content is set to "none", metadata must be true' );
	}

	try {
		const mwn = await getMwn();
		const needsSource = content === BatchContentFormat.source;
		const rvprop = needsSource ?
			'ids|timestamp|contentmodel|content' :
			'ids|timestamp|contentmodel';

		const byResolvedTitle = new Map<string, ApiPageLike>();
		const aliasTo = new Map<string, string>();
		const redirectFrom = new Set<string>();

		if ( followRedirects ) {
			const responses = await mwn.massQuery( {
				action: 'query',
				titles,
				prop: 'revisions',
				rvprop,
				rvslots: 'main',
				redirects: true,
				formatversion: '2'
			}, 'titles' );

			for ( const response of responses ) {
				const query = response?.query;
				if ( !query ) {
					continue;
				}

				const normalized: RedirectOrNormalizedEntry[] = query.normalized ?? [];
				for ( const entry of normalized ) {
					aliasTo.set( entry.from, entry.to );
				}

				const redirects: RedirectOrNormalizedEntry[] = query.redirects ?? [];
				for ( const entry of redirects ) {
					aliasTo.set( entry.from, entry.to );
					redirectFrom.add( entry.from );
				}

				const pages = ( query.pages ?? [] ) as ApiPageLike[];
				for ( const page of pages ) {
					const revs = page.revisions;
					if ( revs ) {
						for ( const rev of revs ) {
							if ( rev.slots?.main ) {
								Object.assign( rev, rev.slots.main );
							}
						}
					}
					byResolvedTitle.set( page.title, page );
				}
			}
		} else {
			// redirects: false — mwn.read() defaults to following redirects, which
			// replaces the requested title in the response with the redirect target
			// and breaks our requested-title lookup. Emit the redirect pseudo-page
			// as-is so callers can see (and sync) it.
			const response = await mwn.read( titles, { rvprop, redirects: false } );
			const pages: ApiPageLike[] = Array.isArray( response ) ? response : [ response ];
			for ( const p of pages ) {
				byResolvedTitle.set( p.title, p );
			}
		}

		const entries: PageEntry[] = [];
		const emitted = new Set<string>();
		const missing: string[] = [];
		const missingSeen = new Set<string>();

		interface PendingTruncation {
			entryIndex: number;
			title: string;
			returnedBytes: number;
			totalBytes: number;
		}
		const pendingTruncations: PendingTruncation[] = [];

		for ( const requested of titles ) {
			let resolvedTitle: string;
			let viaRedirect: boolean;
			if ( followRedirects ) {
				const resolution = resolveChain( requested, aliasTo, redirectFrom );
				resolvedTitle = resolution.resolved;
				viaRedirect = resolution.viaRedirect;
			} else {
				resolvedTitle = requested;
				viaRedirect = false;
			}

			const page = byResolvedTitle.get( resolvedTitle );

			if ( !page || page.missing ) {
				if ( !missingSeen.has( requested ) ) {
					missingSeen.add( requested );
					missing.push( requested );
				}
				continue;
			}

			if ( emitted.has( page.title ) ) {
				continue;
			}
			emitted.add( page.title );

			const rev = page.revisions?.[ 0 ];
			const entry: PageEntry = {
				requestedTitle: requested,
				pageId: page.pageid,
				title: page.title,
				url: getPageUrl( page.title )
			};
			if ( viaRedirect ) {
				entry.redirectedFrom = requested;
			}
			if ( metadata ) {
				entry.latestRevisionId = rev?.revid;
				entry.latestRevisionTimestamp = rev?.timestamp;
				entry.contentModel = rev?.contentmodel;
			}
			if ( needsSource && rev?.content !== undefined ) {
				const truncated = truncateByBytes( rev.content );
				entry.source = truncated.text;
				if ( truncated.truncated ) {
					pendingTruncations.push( {
						entryIndex: entries.length,
						title: page.title,
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes
					} );
				}
			}
			entries.push( entry );
		}

		if ( pendingTruncations.length > 0 ) {
			const sectionLists = await Promise.all(
				pendingTruncations.map( ( p ) => fetchSectionsList( mwn, p.title ) )
			);
			pendingTruncations.forEach( ( p, i ) => {
				const info: TruncationInfo = {
					reason: 'content-truncated',
					returnedBytes: p.returnedBytes,
					totalBytes: p.totalBytes,
					itemNoun: 'wikitext',
					toolName: 'get-pages',
					sections: sectionLists[ i ],
					remedyHint: 'To read a specific section, call get-page again with section=N.'
				};
				entries[ p.entryIndex ].truncation = info;
			} );
		}

		return structuredResult( {
			pages: entries,
			...( missing.length > 0 ? { missing } : {} )
		} );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		return errorResult( category, `Failed to retrieve pages: ${ ( error as Error ).message }`, code );
	}
}
