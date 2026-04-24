import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Mwn } from 'mwn';
import { getMwn } from '../common/mwn.js';
import { getPageUrl } from '../common/utils.js';
import {
	truncationMarker,
	truncateByBytes
} from '../common/truncation.js';

const MAX_TITLES = 50;

export enum BatchContentFormat {
	source = 'source',
	none = 'none'
}

export function getPagesTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'get-pages',
		`Returns multiple wiki pages in one call (wikitext source or metadata only). Suited to reading a cluster of related pages, diffing a page family, or syncing pages to local storage. Accepts up to ${ MAX_TITLES } titles; missing pages are reported inline (not as errors). Each page's content is truncated at 50000 bytes with a trailing marker listing available sections; get-page with section=N fetches a specific section. For a single page or HTML output, use get-page.`,
		{
			titles: z.array( z.string() ).describe( `Array of wiki page titles (1..${ MAX_TITLES })` ),
			content: z.nativeEnum( BatchContentFormat ).optional().default( BatchContentFormat.source ).describe( 'Type of content to return; "none" returns metadata only' ),
			metadata: z.boolean().optional().default( false ).describe( 'Whether to include metadata (page ID, revision info) in the response' ),
			followRedirects: z.boolean().optional().default( true ).describe( 'Follow wiki redirects. When true (default), redirect targets are returned with a "Redirected from:" line in the metadata. Set false to fetch redirect pseudo-pages as-is (sync-fidelity).' )
		},
		{
			title: 'Get pages',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( { titles, content, metadata, followRedirects } ) => handleGetPagesTool(
			titles, content, metadata, followRedirects
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

function buildMetadataLines(
	page: ApiPageLike,
	rev: PageRev | undefined,
	redirectedFrom: string | undefined
): string {
	const lines = [
		`Page ID: ${ page.pageid }`,
		`Title: ${ page.title }`
	];
	if ( redirectedFrom !== undefined ) {
		lines.push( `Redirected from: ${ redirectedFrom }` );
	}
	lines.push(
		`Latest revision ID: ${ rev?.revid }`,
		`Latest revision timestamp: ${ rev?.timestamp }`,
		`Content model: ${ rev?.contentmodel }`,
		`HTML URL: ${ getPageUrl( page.title ) }`
	);
	return lines.join( '\n' );
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
		return {
			content: [ { type: 'text', text: 'titles must contain at least one entry' } as TextContent ],
			isError: true
		};
	}
	if ( titles.length > MAX_TITLES ) {
		return {
			content: [ { type: 'text', text: `titles must contain at most ${ MAX_TITLES } entries` } as TextContent ],
			isError: true
		};
	}
	if ( content === BatchContentFormat.none && !metadata ) {
		return {
			content: [ { type: 'text', text: 'When content is set to "none", metadata must be true' } as TextContent ],
			isError: true
		};
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

		const results: TextContent[] = [];
		// emitted is keyed by resolved title so redirect/normalization aliases
		// collapse to one emission; missingSeen is keyed by requested title
		// because misses have no resolved title to key on.
		const emitted = new Set<string>();
		const missing: string[] = [];
		const missingSeen = new Set<string>();

		interface PendingMarker {
			position: number;
			title: string;
			returnedBytes: number;
			totalBytes: number;
		}
		const pendingMarkers: PendingMarker[] = [];

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

			results.push( { type: 'text', text: `--- ${ requested } ---` } );

			const rev = page.revisions?.[ 0 ];
			if ( metadata ) {
				results.push( {
					type: 'text',
					text: buildMetadataLines( page, rev, viaRedirect ? requested : undefined )
				} );
			}
			if ( needsSource && rev?.content !== undefined ) {
				const truncated = truncateByBytes( rev.content );
				results.push( {
					type: 'text',
					text: metadata ? `Source:\n${ truncated.text }` : truncated.text
				} );
				if ( truncated.truncated ) {
					// Reserve a slot; the marker's section list is filled in after
					// a single parallel pass fetches outlines for every truncated page.
					results.push( { type: 'text', text: '' } );
					pendingMarkers.push( {
						position: results.length - 1,
						title: page.title,
						returnedBytes: truncated.returnedBytes,
						totalBytes: truncated.totalBytes
					} );
				}
			}
		}

		if ( pendingMarkers.length > 0 ) {
			const sectionLists = await Promise.all(
				pendingMarkers.map( ( p ) => fetchSectionsList( mwn, p.title ) )
			);
			pendingMarkers.forEach( ( p, i ) => {
				results[ p.position ] = truncationMarker( {
					reason: 'content-truncated',
					returnedBytes: p.returnedBytes,
					totalBytes: p.totalBytes,
					itemNoun: 'wikitext',
					toolName: 'get-pages',
					sections: sectionLists[ i ],
					remedyHint: 'To read a specific section, call get-page again with section=N.'
				} );
			} );
		}

		if ( missing.length > 0 ) {
			results.push( { type: 'text', text: `Missing: ${ missing.join( ', ' ) }` } );
		}

		return { content: results };
	} catch ( error ) {
		return {
			content: [ {
				type: 'text',
				text: `Failed to retrieve pages: ${ ( error as Error ).message }`
			} as TextContent ],
			isError: true
		};
	}
}
