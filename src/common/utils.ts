import fetch, { Response } from 'node-fetch';
import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';

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

	const fetchOptions: { headers: Record<string, string>; method?: string } = {
		headers: requestHeaders,
		method: options?.method || 'GET'
	};

	const response = await fetch( url, fetchOptions );
	if ( !response.ok ) {
		const errorBody = await response.text().catch( () => 'Could not read error response body' );
		throw new Error(
			`HTTP error! status: ${ response.status } for URL: ${ response.url }. Response: ${ errorBody }`
		);
	}
	return response;
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
