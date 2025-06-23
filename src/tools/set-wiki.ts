import { z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { McpServer, RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { CallToolResult, TextContent, ToolAnnotations } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { updateWikiConfig, getCurrentWikiConfig, setCurrentWiki, getAllWikis } from '../common/config.js';
import { makeApiRequest, fetchPageHtml } from '../common/utils.js';

const COMMON_SCRIPT_PATHS = [ '/w', '' ];

// TODO: Move these types to a dedicated file if we end up using Action API types elsewhere
interface MediaWikiActionApiSiteInfoGeneral {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
	// Omitted other fields for now since we don't use them
}

interface MediaWikiActionApiSiteInfoQuery {
	general: MediaWikiActionApiSiteInfoGeneral;
}

interface MediaWikiActionApiResponse {
	query?: MediaWikiActionApiSiteInfoQuery;
}

interface WikiInfo {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
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
			const url = new URL( args.wikiUrl );
			const allWikis = getAllWikis();

			if ( allWikis[ url.hostname ] ) {
				setCurrentWiki( url.host );
				const newConfig = getCurrentWikiConfig();
				return {
					content: [ {
						type: 'text',
						text: `Wiki set to ${ newConfig.sitename } (${ newConfig.server })`
					} as TextContent ]
				};
			}

			const wikiServer = parseWikiUrl( args.wikiUrl );
			const wikiInfo = await getWikiInfo( wikiServer, args.wikiUrl );

			if ( wikiInfo !== null ) {
				updateWikiConfig( wikiInfo.servername, {
					sitename: wikiInfo.sitename,
					server: wikiInfo.server,
					articlepath: wikiInfo.articlepath,
					scriptpath: wikiInfo.scriptpath
				} );
				setCurrentWiki( wikiInfo.servername );

				const newConfig = getCurrentWikiConfig();
				return {
					content: [
						{
							type: 'text',
							text: `Wiki set to ${ newConfig.sitename } (${ newConfig.server })`
						} as TextContent
					]
				};
			} else {
				return {
					content: [
						{
							type: 'text',
							text: 'Failed to determine wiki info. Please ensure the URL is correct and the wiki is accessible.'
						} as TextContent
					],
					error: true
				};
			}
		}
	);
}

function parseWikiUrl( wikiUrl: string ): string {
	const url = new URL( wikiUrl );
	return `${ url.protocol }//${ url.host }`;
}

async function getWikiInfo(
	wikiServer: string, originalWikiUrl: string
): Promise<WikiInfo | null> {
	return ( await fetchUsingCommonScriptPaths( wikiServer ) ) ??
		( await fetchUsingScriptPathsFromHtml( wikiServer, originalWikiUrl ) );
}

async function fetchWikiInfoFromApi(
	wikiServer: string, scriptPath: string
): Promise<WikiInfo | null> {
	const baseUrl = `${ wikiServer }${ scriptPath }/api.php`;
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
		console.error( `Error fetching wiki info from ${ baseUrl }:`, error );
		return null;
	}

	if ( data === null || data.query?.general === undefined ) {
		return null;
	}

	const general = data.query.general;

	// We don't need to check for every field, the API should be returning the correct values.
	if ( typeof general.scriptpath !== 'string' ) {
		return null;
	}

	return {
		sitename: general.sitename,
		scriptpath: general.scriptpath,
		articlepath: general.articlepath.replace( '/$1', '' ),
		server: general.server,
		servername: general.servername
	};
}

async function fetchUsingCommonScriptPaths(
	wikiServer: string
): Promise<WikiInfo | null> {
	for ( const candidatePath of COMMON_SCRIPT_PATHS ) {
		const apiResult = await fetchWikiInfoFromApi( wikiServer, candidatePath );
		if ( apiResult ) {
			return apiResult;
		}
	}
	return null;
}

async function fetchUsingScriptPathsFromHtml(
	wikiServer: string,
	originalWikiUrl: string
): Promise<WikiInfo | null> {
	const htmlContent = await fetchPageHtml( originalWikiUrl );
	const htmlScriptPathCandidates = extractScriptPathsFromHtml( htmlContent, wikiServer );
	const pathsToTry = htmlScriptPathCandidates.length > 0 ?
		htmlScriptPathCandidates : COMMON_SCRIPT_PATHS;

	for ( const candidatePath of pathsToTry ) {
		const apiResult = await fetchWikiInfoFromApi( wikiServer, candidatePath );
		if ( apiResult ) {
			return apiResult;
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
