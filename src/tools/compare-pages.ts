import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { inlineDiffToText } from '../common/diffFormat.js';
import {
	truncationMarker,
	truncateByBytes
} from '../common/truncation.js';

interface ComparePagesArgs {
	fromRevision?: number;
	fromTitle?: string;
	fromText?: string;
	toRevision?: number;
	toTitle?: string;
	toText?: string;
	includeDiff?: boolean;
}

interface CompareResponse {
	fromrevid?: number;
	fromtitle?: string;
	fromsize?: number;
	fromtimestamp?: string;
	torevid?: number;
	totitle?: string;
	tosize?: number;
	totimestamp?: string;
	body?: string;
	diffsize?: number;
}

type Side = 'from' | 'to';

export function comparePagesTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'compare-pages',
		'Returns the changes between two versions of a wiki page as a compact text diff. Each side accepts a revision ID, page title (latest revision), or supplied wikitext; text-vs-text is rejected. Cheaper than fetching both sources and diffing locally, because only the changes are returned. If a title or revision ID does not exist, an error is returned. Set includeDiff=false for a cheap change-detection response that skips diff rendering and returns just the change flag, revision metadata, and size delta. Diff output is truncated at 50000 bytes with a trailing marker; a narrower revision range or includeDiff=false avoids truncation.',
		{
			fromRevision: z.number().int().positive().optional().describe( 'Revision ID for the "from" side' ),
			fromTitle: z.string().optional().describe( 'Wiki page title for the "from" side (latest revision is used)' ),
			fromText: z.string().optional().describe( 'Supplied wikitext for the "from" side' ),
			toRevision: z.number().int().positive().optional().describe( 'Revision ID for the "to" side' ),
			toTitle: z.string().optional().describe( 'Wiki page title for the "to" side (latest revision is used)' ),
			toText: z.string().optional().describe( 'Supplied wikitext for the "to" side' ),
			includeDiff: z.boolean().optional().describe( 'Include the diff body (default true). Set false for a cheap change-detection response.' )
		},
		{
			title: 'Compare pages',
			readOnlyHint: true,
			destructiveHint: false,
			idempotentHint: true,
			openWorldHint: true
		} as ToolAnnotations,
		async ( args ) => handleComparePagesTool( args as ComparePagesArgs )
	);
}

function errorResult( text: string ): CallToolResult {
	return {
		content: [ { type: 'text', text } as TextContent ],
		isError: true
	};
}

function countSide( side: Side, args: ComparePagesArgs ): number {
	return [
		args[ `${ side }Revision` as const ],
		args[ `${ side }Title` as const ],
		args[ `${ side }Text` as const ]
	].filter( ( v ) => v !== undefined ).length;
}

function validateSide( side: Side, args: ComparePagesArgs ): string | undefined {
	const count = countSide( side, args );
	if ( count === 0 ) {
		return `Must supply exactly one of ${ side }Revision, ${ side }Title, ${ side }Text`;
	}
	if ( count > 1 ) {
		return `Only one of ${ side }Revision, ${ side }Title, ${ side }Text may be supplied`;
	}
	return undefined;
}

function buildSideParams( side: Side, args: ComparePagesArgs ): Record<string, string | number> {
	const params: Record<string, string | number> = {};
	const rev = args[ `${ side }Revision` as const ];
	const title = args[ `${ side }Title` as const ];
	const text = args[ `${ side }Text` as const ];

	if ( rev !== undefined ) {
		params[ `${ side }rev` ] = rev;
	} else if ( title !== undefined ) {
		params[ `${ side }title` ] = title;
	} else if ( text !== undefined ) {
		params[ `${ side }slots` ] = 'main';
		params[ `${ side }text-main` ] = text;
	}
	return params;
}

function formatSideLine(
	prefix: string,
	anchorTitle: string | undefined,
	info: {
		title?: string;
		revid?: number;
		timestamp?: string;
		size?: number;
		isSuppliedText: boolean;
	},
	includeTimestamp: boolean
): string {
	const title = info.title ?? anchorTitle ?? '(unknown)';
	if ( info.isSuppliedText ) {
		return `${ prefix }${ title } (supplied text, ${ info.size ?? 0 } bytes)`;
	}
	const metaParts: string[] = [];
	if ( includeTimestamp && info.timestamp ) {
		metaParts.push( info.timestamp );
	}
	metaParts.push( `${ info.size ?? 0 } bytes` );
	const revClause = info.revid !== undefined ? ` @ rev ${ info.revid }` : '';
	return `${ prefix }${ title }${ revClause } (${ metaParts.join( ', ' ) })`;
}

function detectChanged( compare: CompareResponse, diffText: string ): boolean {
	if ( compare.fromrevid !== undefined && compare.torevid !== undefined ) {
		return compare.fromrevid !== compare.torevid;
	}
	if ( compare.body !== undefined ) {
		return diffText.length > 0;
	}
	if ( compare.diffsize !== undefined ) {
		return compare.diffsize > 0;
	}
	return ( compare.fromsize ?? 0 ) !== ( compare.tosize ?? 0 );
}

export async function handleComparePagesTool(
	args: ComparePagesArgs
): Promise<CallToolResult> {
	const fromError = validateSide( 'from', args );
	if ( fromError ) {
		return errorResult( fromError );
	}
	const toError = validateSide( 'to', args );
	if ( toError ) {
		return errorResult( toError );
	}
	if ( args.fromText !== undefined && args.toText !== undefined ) {
		return errorResult( 'Cannot compare supplied text against supplied text' );
	}

	const includeDiff = args.includeDiff ?? true;

	const params: Record<string, string | number> = {
		action: 'compare',
		prop: includeDiff ? 'ids|title|size|timestamp|diff' : 'ids|title|size|diffsize',
		formatversion: '2',
		...buildSideParams( 'from', args ),
		...buildSideParams( 'to', args )
	};

	try {
		const mwn = await getMwn();
		const response = await mwn.request( params );
		const compare = response.compare as CompareResponse | undefined;

		if ( !compare ) {
			return errorResult( 'Failed to compare pages: no compare result returned' );
		}

		const anchorTitle = compare.fromtitle ?? compare.totitle;
		const diffText = compare.body ? inlineDiffToText( compare.body ) : '';
		const changed = detectChanged( compare, diffText );
		// MediaWiki omits fromsize/tosize when the side is supplied text;
		// we have the text locally, so compute the byte length ourselves.
		const fromSize = compare.fromsize ?? (
			args.fromText !== undefined ? Buffer.byteLength( args.fromText, 'utf8' ) : 0
		);
		const toSize = compare.tosize ?? (
			args.toText !== undefined ? Buffer.byteLength( args.toText, 'utf8' ) : 0
		);
		const sizeDelta = toSize - fromSize;

		const headerLines = [
			`Changed: ${ changed }`,
			formatSideLine( 'From: ', anchorTitle, {
				title: compare.fromtitle,
				revid: compare.fromrevid,
				timestamp: compare.fromtimestamp,
				size: fromSize,
				isSuppliedText: args.fromText !== undefined
			}, includeDiff ),
			formatSideLine( 'To:   ', anchorTitle, {
				title: compare.totitle,
				revid: compare.torevid,
				timestamp: compare.totimestamp,
				size: toSize,
				isSuppliedText: args.toText !== undefined
			}, includeDiff ),
			`Size delta: ${ sizeDelta > 0 ? '+' : '' }${ sizeDelta }`
		];

		const results: TextContent[] = [
			{ type: 'text', text: headerLines.join( '\n' ) }
		];

		if ( includeDiff && changed && diffText ) {
			const truncated = truncateByBytes( diffText );
			results.push( { type: 'text', text: truncated.text } );
			if ( truncated.truncated ) {
				results.push( truncationMarker( {
					reason: 'content-truncated',
					returnedBytes: truncated.returnedBytes,
					totalBytes: truncated.totalBytes,
					itemNoun: 'diff',
					toolName: 'compare-pages',
					remedyHint: 'To avoid truncation, compare a narrower revision range or set includeDiff=false for a metadata-only response.'
				} ) );
			}
		}

		return { content: results };
	} catch ( error ) {
		const msg = ( error as Error ).message;
		if ( /nosuchrevid/i.test( msg ) ) {
			const idMatch = msg.match( /\b(\d+)\b/ );
			if ( idMatch ) {
				return errorResult( `Revision ${ idMatch[ 1 ] } not found` );
			}
			return errorResult( `Revision not found: ${ msg }` );
		}
		if ( /missingtitle/i.test( msg ) ) {
			const titleMatch = msg.match( /["'`]([^"'`]+)["'`]/ );
			const missingTitle = titleMatch?.[ 1 ] ?? args.fromTitle ?? args.toTitle;
			return errorResult(
				missingTitle ?
					`Page "${ missingTitle }" not found` :
					`Page not found: ${ msg }`
			);
		}
		return errorResult( `Failed to compare pages: ${ msg }` );
	}
}
