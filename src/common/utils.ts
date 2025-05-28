import fetch, { Response } from 'node-fetch';
import { SERVER_NAME, SERVER_VERSION } from '../server.js';
import { SCRIPT_PATH, WIKI_SERVER } from './config.js';

const USER_AGENT: string = `${ SERVER_NAME }/${ SERVER_VERSION }`;

async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
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

	const response = await fetch( url, { headers: requestHeaders } );
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
): Promise<T | null> {
	try {
		const response = await fetchCore( url, {
			params,
			headers: { Accept: 'application/json' }
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		// console.error('Error making API request:', error);
		return null;
	}
}

export async function makeRestGetRequest<T>(
	path: string,
	params?: Record<string, string>
): Promise<T | null> {
	try {
		const response = await fetchCore( `${ WIKI_SERVER() }${ SCRIPT_PATH() }/rest.php${ path }`, {
			params,
			headers: { Accept: 'application/json' }
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		// console.error('Error making API request:', error);
		return null;
	}
}

export async function fetchPageHtml( url: string ): Promise<string | null> {
	try {
		const response = await fetchCore( url );
		return await response.text();
	} catch ( error ) {
		// console.error(`Error fetching HTML page from ${url}:`, error);
		return null;
	}
}

export async function fetchImageAsBase64( url: string ): Promise<string | null> {
	try {
		const response = await fetchCore( url );
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from( arrayBuffer );
		return buffer.toString( 'base64' );
	} catch ( error ) {
		// console.error(`Error fetching image from ${url}:`, error);
		return null;
	}
}
