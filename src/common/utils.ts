import fetch, { Response } from 'node-fetch';
import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken, articlePath, privateWiki } from './config.js';
import { getMwn } from './mwn.js';

type RequestConfig = {
	headers: Record<string, string>;
	body: Record<string, unknown> | undefined;
};

async function withAuth(
	headers: Record<string, string>,
	body: Record<string, unknown> | undefined,
	needAuth: boolean
): Promise<RequestConfig> {
	if ( !needAuth && !privateWiki() ) {
		return { headers, body };
	}

	const token = oauthToken();

	if ( token !== undefined && token !== null ) {
		// OAuth2 authentication - just add Bearer token
		return {
			headers: { ...headers, Authorization: `Bearer ${ token }` },
			body
		};
	}

	// Cookie-based authentication - add cookies and CSRF token
	const cookies = await getCookiesFromJar();
	if ( cookies === undefined ) {
		return { headers, body };
	}

	return {
		headers: { ...headers, Cookie: cookies },
		body: body ? { ...body, token: await getCsrfToken() } : body
	};
}

async function getCsrfToken(): Promise<string> {
	const mwn = await getMwn();
	return await mwn.getCsrfToken();
}

async function getCookiesFromJar(): Promise<string | undefined> {
	const mwn = await getMwn();
	const cookieJar = mwn.cookieJar;
	if ( !cookieJar ) {
		return undefined;
	}

	// Get cookies for the REST API URL
	const restApiUrl = `${ wikiServer() }${ scriptPath() }/rest.php`;
	const cookies = cookieJar.getCookieStringSync( restApiUrl );

	if ( cookies ) {
		return cookies;
	}

	// Fallback: try getting cookies for the domain
	return cookieJar.getCookieStringSync( wikiServer() ) || undefined;
}

async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
		body?: Record<string, unknown>;
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

	const fetchOptions: { headers: Record<string, string>; method?: string; body?: string } = {
		headers: requestHeaders,
		method: options?.method || 'GET'
	};
	if ( options?.body ) {
		fetchOptions.body = JSON.stringify( options.body );
	}
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

export async function makeRestGetRequest<T>(
	path: string,
	params?: Record<string, string>,
	needAuth: boolean = false
): Promise<T> {
	const headers: Record<string, string> = {
		Accept: 'application/json'
	};

	const { headers: authHeaders } = await withAuth(
		headers,
		undefined,
		needAuth
	);

	const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/rest.php${ path }`, {
		params,
		headers: authHeaders
	} );
	return ( await response.json() ) as T;
}

export async function makeRestPutRequest<T>(
	path: string,
	body: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json'
	};

	const { headers: authHeaders, body: authBody } = await withAuth(
		headers,
		body,
		needAuth
	);

	const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/rest.php${ path }`, {
		headers: authHeaders,
		method: 'PUT',
		body: authBody
	} );
	return ( await response.json() ) as T;
}

export async function makeRestPostRequest<T>(
	path: string,
	body?: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T> {
	const headers: Record<string, string> = {
		Accept: 'application/json',
		'Content-Type': 'application/json'
	};

	const { headers: authHeaders, body: authBody } = await withAuth(
		headers,
		body,
		needAuth
	);

	const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/rest.php${ path }`, {
		headers: authHeaders,
		method: 'POST',
		body: authBody
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

export async function fetchImageAsBase64( url: string ): Promise<string | null> {
	try {
		const response = await fetchCore( url );
		const arrayBuffer = await response.arrayBuffer();
		const buffer = Buffer.from( arrayBuffer );
		return buffer.toString( 'base64' );
	} catch {
		return null;
	}
}

export function getPageUrl( title: string ): string {
	return `${ wikiServer() }${ articlePath() }/${ encodeURIComponent( title ) }`;
}

export function formatEditComment( tool: string, comment?: string ): string {
	const suffix = `(via ${ tool } on MediaWiki MCP Server)`;
	if ( !comment ) {
		return `Automated edit ${ suffix }`;
	}
	return `${ comment } ${ suffix }`;
}
