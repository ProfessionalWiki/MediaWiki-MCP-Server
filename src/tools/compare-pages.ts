import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { getMwn } from '../common/mwn.js';
import { inlineDiffToText } from '../common/diffFormat.js';
import { truncateByBytes } from '../common/truncation.js';
import { TruncationSchema } from '../common/schemas.js';
import { classifyError, errorResult } from '../common/errorMapping.js';
import { structuredResult } from '../common/structuredResult.js';

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

const SideSchema = z.object( {
	title: z.string().optional(),
	revisionId: z.number().int().nonnegative().optional(),
	timestamp: z.string().optional(),
	size: z.number().int().nonnegative(),
	isSuppliedText: z.boolean()
} );

const outputSchema = {
	changed: z.boolean(),
	from: SideSchema,
	to: SideSchema,
	sizeDelta: z.number().int(),
	diff: z.string().optional(),
	truncation: TruncationSchema.optional()
};

export function comparePagesTool( server: McpServer ): RegisteredTool {
	return server.registerTool(
		'compare-pages',
		{
			description: 'Returns the changes between two versions of a wiki page as a compact text diff. Each side accepts a revision ID, page title (latest revision), or supplied wikitext; text-vs-text is rejected. Cheaper than fetching both sources and diffing locally, because only the changes are returned. If a title or revision ID does not exist, an error is returned. Set includeDiff=false for a cheap change-detection response that skips diff rendering and returns just the change flag, revision metadata, and size delta. Diff output is truncated at 50000 bytes with a trailing marker; a narrower revision range or includeDiff=false avoids truncation.',
			inputSchema: {
				fromRevision: z.number().int().positive().optional().describe( 'Revision ID for the "from" side' ),
				fromTitle: z.string().optional().describe( 'Wiki page title for the "from" side (latest revision is used)' ),
				fromText: z.string().optional().describe( 'Supplied wikitext for the "from" side' ),
				toRevision: z.number().int().positive().optional().describe( 'Revision ID for the "to" side' ),
				toTitle: z.string().optional().describe( 'Wiki page title for the "to" side (latest revision is used)' ),
				toText: z.string().optional().describe( 'Supplied wikitext for the "to" side' ),
				includeDiff: z.boolean().optional().describe( 'Include the diff body (default true). Set false for a cheap change-detection response.' )
			},
			outputSchema,
			annotations: {
				title: 'Compare pages',
				readOnlyHint: true,
				destructiveHint: false,
				idempotentHint: true,
				openWorldHint: true
			} as ToolAnnotations
		},
		async ( args ) => handleComparePagesTool( args as ComparePagesArgs )
	);
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
		return errorResult( 'invalid_input', fromError );
	}
	const toError = validateSide( 'to', args );
	if ( toError ) {
		return errorResult( 'invalid_input', toError );
	}
	if ( args.fromText !== undefined && args.toText !== undefined ) {
		return errorResult( 'invalid_input', 'Cannot compare supplied text against supplied text' );
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
			return errorResult( 'upstream_failure', 'Failed to compare pages: no compare result returned' );
		}

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

		const payload: Record<string, unknown> = {
			changed,
			from: {
				title: compare.fromtitle,
				revisionId: compare.fromrevid,
				timestamp: includeDiff ? compare.fromtimestamp : undefined,
				size: fromSize,
				isSuppliedText: args.fromText !== undefined
			},
			to: {
				title: compare.totitle,
				revisionId: compare.torevid,
				timestamp: includeDiff ? compare.totimestamp : undefined,
				size: toSize,
				isSuppliedText: args.toText !== undefined
			},
			sizeDelta
		};

		if ( includeDiff && changed && diffText ) {
			const truncated = truncateByBytes( diffText );
			payload.diff = truncated.text;
			if ( truncated.truncated ) {
				payload.truncation = {
					reason: 'content-truncated',
					returnedBytes: truncated.returnedBytes,
					totalBytes: truncated.totalBytes,
					itemNoun: 'diff',
					toolName: 'compare-pages',
					remedyHint: 'To avoid truncation, compare a narrower revision range or set includeDiff=false for a metadata-only response.'
				};
			}
		}

		return structuredResult( payload );
	} catch ( error ) {
		const { category, code } = classifyError( error );
		const msg = ( error as Error ).message;
		if ( code === 'nosuchrevid' ) {
			const idMatch = msg.match( /\b(\d+)\b/ );
			let id: string | undefined = idMatch?.[ 1 ];
			if ( id === undefined && args.fromRevision !== undefined ) {
				id = String( args.fromRevision );
			}
			if ( id === undefined && args.toRevision !== undefined ) {
				id = String( args.toRevision );
			}
			return errorResult(
				'not_found',
				id !== undefined ? `Revision ${ id } not found` : 'Revision not found',
				code
			);
		}
		if ( code === 'missingtitle' ) {
			const titleMatch = msg.match( /["'`]([^"'`]+)["'`]/ );
			const title = titleMatch?.[ 1 ] ?? args.fromTitle ?? args.toTitle;
			return errorResult(
				'not_found',
				title !== undefined ? `Page "${ title }" not found` : 'Page not found',
				code
			);
		}
		return errorResult( category, `Failed to compare pages: ${ msg }`, code );
	}
}
