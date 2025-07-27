import fetch, { Response } from 'node-fetch';
import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken, articlePath, wikiLanguage } from './config.js';

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
		'User-Agent': USER_AGENT,
		'Accept-Language': wikiLanguage()
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
): Promise<T | null> {
	const response = await fetchCore( url, {
		params,
		headers: { Accept: 'application/json' }
	} );
	return ( await response.json() ) as T;
}

// Cache for CSRF tokens to avoid repeated requests
let csrfTokenCache: { token: string; expires: number } | null = null;

/**
 * Fetches a CSRF token for write operations using the legacy API
 */
export async function getCsrfToken(): Promise<string | null> {
	// Check if we have a valid cached token (expires in 30 minutes)
	if ( csrfTokenCache && csrfTokenCache.expires > Date.now() ) {
		return csrfTokenCache.token;
	}

	try {
		const token = oauthToken();
		if ( !token ) {
			console.error( 'No OAuth token available for CSRF token request' );
			return null;
		}

		const headers: Record<string, string> = {
			Accept: 'application/json',
			Authorization: `Bearer ${ token }`
		};

		// Use the legacy API to get CSRF token since REST API csrf endpoint may not be available
		const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/api.php`, {
			params: {
				action: 'query',
				meta: 'tokens',
				type: 'csrf',
				format: 'json'
			},
			headers: headers
		} );

		const data = ( await response.json() ) as { 
			query?: { 
				tokens?: { 
					csrftoken?: string 
				} 
			} 
		};
		
		const csrfToken = data.query?.tokens?.csrftoken;
		if ( csrfToken && csrfToken !== '+\\' ) {
			// Cache the token for 30 minutes
			csrfTokenCache = {
				token: csrfToken,
				expires: Date.now() + ( 30 * 60 * 1000 )
			};
			return csrfToken;
		}
		
		console.error( 'No valid CSRF token in response:', data );
		return null;
	} catch ( error ) {
		console.error( 'Error fetching CSRF token:', error );
		return null;
	}
}

export async function makeRestGetRequest<T>(
	path: string,
	params?: Record<string, string>,
	needAuth: boolean = false
): Promise<T | null> {
	try {
		const headers: Record<string, string> = {
			Accept: 'application/json'
		};
		const token = oauthToken();
		if ( needAuth && token !== undefined ) {
			headers.Authorization = `Bearer ${ token }`;
		}

		// Add language parameter for interface language
		const enhancedParams = {
			...params,
			uselang: wikiLanguage()
		};

		const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/rest.php${ path }`, {
			params: enhancedParams,
			headers: headers
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		// console.error('Error making API request:', error);
		return null;
	}
}

export async function makeRestPutRequest<T>(
	path: string,
	body: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T | null> {
	try {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		};
		const token = oauthToken();
		if ( needAuth && token !== undefined ) {
			headers.Authorization = `Bearer ${ token }`;
		}

		// OAuth 2.0 provides CSRF protection, so no token needed when using OAuth
		// Only get CSRF token for non-OAuth authenticated requests
		const oAuthToken = oauthToken();
		const isOAuth = oAuthToken && oAuthToken.length > 50; // JWT tokens are longer than legacy tokens
		const csrfToken = (needAuth && !isOAuth) ? await getCsrfToken() : null;
		if ( needAuth && !isOAuth && !csrfToken ) {
			throw new Error( 'Failed to obtain CSRF token for write operation' );
		}

		// Add language parameter for interface language
		const enhancedParams: Record<string, string> = {
			uselang: wikiLanguage()
		};

		// Add CSRF token to request body if available
		const enhancedBody = { ...body };
		if ( csrfToken ) {
			enhancedBody.token = csrfToken;
		}

		const response = await fetchCore( `${ wikiServer() }${ scriptPath() }/rest.php${ path }`, {
			params: enhancedParams,
			headers: headers,
			method: 'PUT',
			body: enhancedBody
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		// For write operations, propagate HTTP errors to tools for better error messages
		// Only catch and return null for unexpected errors (JSON parsing, network issues, etc.)
		if ( error instanceof Error && error.message.includes( 'HTTP error!' ) ) {
			throw error;
		}
		// console.error('Error making API request:', error);
		return null;
	}
}

export async function makeRestPostRequest<T>(
	path: string,
	body?: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T | null> {
	try {
		const headers: Record<string, string> = {
			Accept: 'application/json',
			'Content-Type': 'application/json'
		};
		const token = oauthToken();
		if ( needAuth && token !== undefined ) {
			headers.Authorization = `Bearer ${ token }`;
		}

		// OAuth 2.0 provides CSRF protection, so no token needed when using OAuth
		// Only get CSRF token for non-OAuth authenticated requests
		const oAuthToken = oauthToken();
		const isOAuth = oAuthToken && oAuthToken.length > 50; // JWT tokens are longer than legacy tokens
		const csrfToken = (needAuth && !isOAuth) ? await getCsrfToken() : null;
		if ( needAuth && !isOAuth && !csrfToken ) {
			throw new Error( 'Failed to obtain CSRF token for write operation' );
		}

		// Add language parameter for interface language
		const enhancedParams: Record<string, string> = {
			uselang: wikiLanguage()
		};

		// Add CSRF token to request body if available
		const enhancedBody = body ? { ...body } : {};
		if ( csrfToken ) {
			enhancedBody.token = csrfToken;
		}

		const fullUrl = `${ wikiServer() }${ scriptPath() }/rest.php${ path }`;
		console.error( `DEBUG: Making REST POST request to: ${ fullUrl }` );
		console.error( `DEBUG: OAuth token length: ${ oAuthToken ? oAuthToken.length : 'null' }` );
		console.error( `DEBUG: Is OAuth: ${ isOAuth }` );
		console.error( `DEBUG: CSRF token: ${ csrfToken ? 'present' : 'null' }` );
		const response = await fetchCore( fullUrl, {
			params: enhancedParams,
			headers: headers,
			method: 'POST',
			body: enhancedBody
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		// For write operations, propagate HTTP errors to tools for better error messages
		// Only catch and return null for unexpected errors (JSON parsing, network issues, etc.)
		if ( error instanceof Error && error.message.includes( 'HTTP error!' ) ) {
			throw error;
		}
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

export function getPageUrl( title: string ): string {
	return `${ wikiServer() }${ articlePath() }/${ encodeURIComponent( title ) }`;
}
