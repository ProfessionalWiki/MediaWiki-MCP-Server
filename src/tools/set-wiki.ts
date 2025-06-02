import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { updateConfig, getConfig } from '../common/config.js';
import { makeApiRequest, fetchPageHtml } from '../common/utils.js';

const COMMON_SCRIPT_PATHS = [ '/w', '/' ];

// TODO: Move these types to a dedicated file if we end up using Action API types elsewhere
interface MediaWikiActionApiSiteInfoGeneral {
	scriptpath: string;
	articlepath: string;
}

interface MediaWikiActionApiSiteInfoQuery {
	general: MediaWikiActionApiSiteInfoGeneral;
}

interface MediaWikiActionApiResponse {
	query?: MediaWikiActionApiSiteInfoQuery;
}

interface WikiPathsResult {
	scriptPath: string | undefined;
	articlePath: string | undefined;
}

export function setWikiTool( server: McpServer ): RegisteredTool {
	return server.tool(
		'set-wiki',
		'Set the wiki to use for the current session.',
		{
			wikiUrl: z.string().url().describe( 'Any URL from the target wiki (e.g. https://en.wikipedia.org/wiki/Main_Page).' )
		},
		{
			title: 'Set wiki',
			destructiveHint: true
		} as ToolAnnotations,
		async ( args: {
			wikiUrl: string;
		} ): Promise<CallToolResult> => {
			try {
				const wikiServer = parseWikiUrl( args.wikiUrl );
				const { scriptPath, articlePath } = await getWikiPaths( wikiServer, args.wikiUrl );

				if ( scriptPath !== undefined && articlePath !== undefined ) {
					updateConfig( {
						WIKI_SERVER: wikiServer,
						ARTICLE_PATH: articlePath,
						SCRIPT_PATH: scriptPath
					} );

					const newConfig = getConfig();
					return {
						content: [
							{
								type: 'text',
								text: [
									'Wiki set successfully.',
									`Wiki Server: ${ newConfig.WIKI_SERVER }`,
									`Article Path: ${ newConfig.ARTICLE_PATH }`,
									`Script Path: ${ newConfig.SCRIPT_PATH }`
								].join( '\n' )
							} as TextContent
						]
					};
				} else {
					return {
						content: [
							{
								type: 'text',
								text: 'Failed to determine wiki paths. Please ensure the URL is correct and the wiki is accessible.'
							} as TextContent
						],
						error: true
					};
				}
			} catch ( error ) {
				return {
					content: [
						{
							type: 'text',
							text: `Failed to set wiki: ${ ( error as Error ).message }`
						} as TextContent
					],
					isError: true
				};
			}
		}
	);
}

function parseWikiUrl( wikiUrl: string ): string {
	const url = new URL( wikiUrl );
	return `${ url.protocol }//${ url.host }`;
}

async function getWikiPaths(
	wikiServer: string, originalWikiUrl: string
): Promise<WikiPathsResult> {
	const phase1Result = await probeWikiPathsFromApi( wikiServer );

	if ( phase1Result ) {
		return phase1Result;
	}

	const phase2Result = await probeWikiPathsFromHtml( wikiServer, originalWikiUrl );
	if ( phase2Result ) {
		return phase2Result;
	}

	return { scriptPath: undefined, articlePath: undefined };
}

async function probeWikiPathsFromApi(
	wikiServer: string,
	pathsToTry?: string[]
): Promise<WikiPathsResult | null> {
	const paths = pathsToTry ?? COMMON_SCRIPT_PATHS;
	for ( const candidatePath of paths ) {
		const apiResult = await getWikiPathsFromApi( wikiServer, candidatePath );
		if ( apiResult ) {
			return apiResult;
		}
	}
	return null;
}

async function getWikiPathsFromApi(
	wikiServer: string, candidatePath: string
): Promise<WikiPathsResult | null> {
	const effectiveCandidatePath = candidatePath === '/' ? '' : candidatePath;
	const baseUrl = `${ wikiServer }${ effectiveCandidatePath }/api.php`;
	const params = {
		action: 'query',
		meta: 'siteinfo',
		siprop: 'general',
		format: 'json',
		origin: '*'
	};

	let data: MediaWikiActionApiResponse | null = null;

	try {
		data = await makeApiRequest<MediaWikiActionApiResponse>( baseUrl, params );
	} catch ( error ) {
		// Suppress error to allow probing of other paths
	}

	if ( data === null ) {
		return null;
	}

	const scriptpath = data.query?.general?.scriptpath;
	const articlepath = data.query?.general?.articlepath;

	if ( typeof scriptpath === 'string' && typeof articlepath === 'string' ) {
		return {
			scriptPath: scriptpath.replace( '/$1', '' ),
			articlePath: articlepath.replace( '/$1', '' )
		};
	}

	return null;
}

async function probeWikiPathsFromHtml(
	wikiServer: string,
	originalWikiUrl: string
): Promise<WikiPathsResult | null> {
	const htmlContent = await fetchPageHtml( originalWikiUrl );
	const htmlScriptPathCandidates = extractScriptPathsFromHtml( htmlContent, wikiServer );
	const uniqueFurtherCandidates = htmlScriptPathCandidates.filter(
		( p ) => !COMMON_SCRIPT_PATHS.includes( p )
	);

	if ( uniqueFurtherCandidates.length > 0 ) {
		const apiDiscoveryResult = await probeWikiPathsFromApi(
			wikiServer,
			uniqueFurtherCandidates
		);
		if ( apiDiscoveryResult ) {
			return apiDiscoveryResult;
		}
	}
	return null;
}

function extractScriptPathsFromHtml( htmlContent: string | null, wikiServer: string ): string[] {
	const candidatesFromHtml: string[] = [];
	if ( htmlContent ) {
		const fromSearchForm = extractScriptPathFromSearchForm( htmlContent, wikiServer );
		if ( fromSearchForm !== null ) {
			candidatesFromHtml.push( fromSearchForm );
		}
	}

	const uniqueCandidatesFromHtml = [ ...new Set( candidatesFromHtml ) ];
	return uniqueCandidatesFromHtml.filter( ( p ) => typeof p === 'string' && ( p === '' || p.trim() !== '' ) );
}

function extractScriptPathFromSearchForm( htmlContent: string, wikiServer: string ): string | null {
	const searchFormMatch = htmlContent.match( /<form[^>]+id=['"]searchform['"][^>]+action=['"]([^'"]*index\.php[^'"]*)['"]/i );
	if ( searchFormMatch && searchFormMatch[ 1 ] ) {
		const actionAttribute = searchFormMatch[ 1 ];
		try {
			const fullActionUrl = new URL( actionAttribute, wikiServer );
			const path = fullActionUrl.pathname;
			const indexPathIndex = path.toLowerCase().lastIndexOf( '/index.php' );
			if ( indexPathIndex !== -1 ) {
				return path.slice( 0, indexPathIndex );
			}
		} catch ( e ) {}
	}
	return null;
}
