import fetch, { Response } from 'node-fetch';
import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import { assertPublicDestination, buildPinnedAgent } from './ssrfGuard.js';

const MAX_REDIRECTS = 5;

async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
		method?: string;
	}
): Promise<Response> {
	let url = baseUrl;

	if ( url.startsWith( '//' ) ) {
		url = 'https:' + url;
	}

	if ( options?.params ) {
		const queryString = new URLSearchParams( options.params ).toString();
		if ( queryString ) {
			url = `${ url }?${ queryString }`;
		}
	}

	const requestHeaders: Record<string, string> = {
		'User-Agent': USER_AGENT
	};

	if ( options?.headers ) {
		Object.assign( requestHeaders, options.headers );
	}

	let currentUrl = url;
	let response: Response | undefined;
	for ( let hop = 0; hop <= MAX_REDIRECTS; hop++ ) {
		const addresses = await assertPublicDestination( currentUrl );
		const agent = buildPinnedAgent( currentUrl, addresses );
		response = await fetch( currentUrl, {
			headers: requestHeaders,
			method: options?.method || 'GET',
			redirect: 'manual',
			agent
		} );

		if ( response.status < 300 || response.status >= 400 ) {
			break;
		}

		const location = response.headers.get( 'location' );
		if ( !location ) {
			break;
		}

		if ( hop === MAX_REDIRECTS ) {
			throw new Error( `Too many redirects (>${ MAX_REDIRECTS }) starting from ${ url }` );
		}

		currentUrl = new URL( location, currentUrl ).toString();
	}

	// response is always assigned inside the loop (loop runs at least once).
	const finalResponse = response as Response;
	if ( !finalResponse.ok ) {
		const errorBody = await finalResponse.text().catch( () => 'Could not read error response body' );
		throw new Error(
			`HTTP error! status: ${ finalResponse.status } for URL: ${ finalResponse.url }. Response: ${ errorBody }`
		);
	}
	return finalResponse;
}

export async function makeApiRequest<T>(
	url: string,
	params?: Record<string, string>
): Promise<T> {
	const response = await fetchCore( url, {
		params,
		headers: { Accept: 'application/json' }
	} );
	return ( await response.json() ) as T;
}

export async function fetchPageHtml( url: string ): Promise<string | null> {
	try {
		const response = await fetchCore( url );
		return await response.text();
	} catch {
		return null;
	}
}

export function getPageUrl( title: string ): string {
	const { server, articlepath } = wikiService.getCurrent().config;
	// MediaWiki convention: spaces become underscores. encodeURI preserves
	// '/' (subpages) and ':' (namespace prefixes) while encoding spaces and
	// non-ASCII characters. Characters disallowed in MW titles ('#', '?',
	// '|', '[', ']', etc.) cannot reach this function via a real page title.
	return `${ server }${ articlepath }/${ encodeURI( title.replace( / /g, '_' ) ) }`;
}

export function formatEditComment( tool: string, comment?: string ): string {
	const suffix = `(via ${ tool } on MediaWiki MCP Server)`;
	if ( !comment ) {
		return `Automated edit ${ suffix }`;
	}
	return `${ comment } ${ suffix }`;
}
