import fetch, { Response } from 'node-fetch';
import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken, articlePath, wikiLanguage } from './config.js';

function joinPaths( ...segments: string[] ): string {
    // Examples:
    // joinPaths('a', 'b', 'c')          -> 'a/b/c'
    // joinPaths('/a/', '/b', 'c/')      -> 'a/b/c'
    // joinPaths('a', '', 'b')           -> 'a/b'
    // joinPaths('', '', '')             -> ''
    // joinPaths('rest.php', 'v1/page')  -> 'rest.php/v1/page'
    return segments.map( segment => segment.replace( /^\/|\/$/g, '' ) ) // Remove leading/trailing slashes from each segment
                   .filter( segment => segment !== '' ) // Remove any empty segments
                   .join( '/' ); // Join with a single slash
}

function buildRestApiUrl( server: string, sp: string, path: string ): string {
    const baseUrl = new URL( server );
    const pathSegments: string[] = [];

    // Add the base URL's pathname, if it's not just '/'
    if ( baseUrl.pathname && baseUrl.pathname !== '/' ) {
        pathSegments.push( baseUrl.pathname );
    }

    // Add the script path, if it exists
    if ( sp ) {
        pathSegments.push( sp );
    }

    // Add 'rest.php'
    pathSegments.push( 'rest.php' );

    // Add the specific API path
    pathSegments.push( path );

    // Join all segments using the new helper and assign to baseUrl.pathname
    baseUrl.pathname = '/' + joinPaths( ...pathSegments );

    return baseUrl.toString();
}



async function fetchCore(
	baseUrl: string,
	options?: {
		params?: Record<string, string>;
		headers?: Record<string, string>;
		body?: Record<string, unknown>;
		method?: string;
		timeout?: number;
		retries?: number;
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

	const fetchOptions: { 
		headers: Record<string, string>; 
		method?: string; 
		body?: string;
		timeout?: number;
	} = {
		headers: requestHeaders,
		method: options?.method || 'GET',
		timeout: options?.timeout || 30000 // 30 second timeout by default
	};
	
	if ( options?.body ) {
		fetchOptions.body = JSON.stringify( options.body );
	}

	const maxRetries = options?.retries || 2;
	let lastError: Error;

	for ( let attempt = 0; attempt <= maxRetries; attempt++ ) {
		try {
			const response = await fetch( url, fetchOptions );
			if ( !response.ok ) {
				const errorBody = await response.text().catch( () => 'Could not read error response body' );
				throw new Error(
					`HTTP error! status: ${ response.status } for URL: ${ response.url }. Response: ${ errorBody }`
				);
			}
			return response;
		} catch ( error ) {
			lastError = error as Error;
			
			// Don't retry for HTTP errors (4xx, 5xx), only for network errors
			if ( lastError.message.includes( 'HTTP error!' ) ) {
				throw lastError;
			}
			
			// If this is the last attempt, throw the error
			if ( attempt === maxRetries ) {
				// Enhance error message with more details for network issues
				if ( lastError.message.includes( 'ETIMEDOUT' ) ) {
					throw new Error( `Network timeout after ${ fetchOptions.timeout }ms when connecting to ${ url }. Original error: ${ lastError.message }` );
				} else if ( lastError.message.includes( 'ECONNREFUSED' ) ) {
					throw new Error( `Connection refused when connecting to ${ url }. Server may be down. Original error: ${ lastError.message }` );
				} else if ( lastError.message.includes( 'ENOTFOUND' ) ) {
					throw new Error( `DNS lookup failed for ${ url }. Check the server URL. Original error: ${ lastError.message }` );
				} else {
					throw new Error( `Network error when connecting to ${ url }. Original error: ${ lastError.message }` );
				}
			}
			
			// Wait before retrying (exponential backoff)
			const delay = Math.min( 1000 * Math.pow( 2, attempt ), 5000 );
			await new Promise( resolve => setTimeout( resolve, delay ) );
		}
	}

	throw lastError!;
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
					csrftoken?: string;
				};
			};
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

		const response = await fetchCore( buildRestApiUrl( wikiServer(), scriptPath(), path ), {
			params: enhancedParams,
			headers: headers
		} );
		return ( await response.json() ) as T;
	} catch ( error ) {
		console.error( 'Error making REST GET request:', error );
		// Re-throw the error so tools can provide better error messages to users
		throw error;
	}
}

export async function makeRestPutRequest<T>(
	path: string,
	body: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T> {
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
		// JWT tokens are longer than legacy tokens
		const isOAuth = oAuthToken && oAuthToken.length > 50;
		const csrfToken = ( needAuth && !isOAuth ) ?
			await getCsrfToken() : null;
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

		const response = await fetchCore( buildRestApiUrl( wikiServer(), scriptPath(), path ), {
			params: enhancedParams,
			headers: headers,
			method: 'PUT',
			body: enhancedBody
		} );
		const rawResponseText = await response.text();
		let data: T;
		try {
			data = JSON.parse( rawResponseText ) as T;
		} catch ( jsonError ) {
			throw new Error( `Failed to parse JSON response (PUT). Raw response: ${ rawResponseText }. Error: ${ ( jsonError as Error ).message }` );
		}
		if ( data === null || data === undefined ) {
			throw new Error( `API returned no data or malformed JSON (PUT). Raw response: ${ rawResponseText }` );
		}
		return data;
	} catch ( error ) {
		// For write operations, propagate HTTP errors to tools for better error messages
		// Re-throw all errors to ensure they are caught by the calling tool for proper fallback handling
		throw error;
	}
}

export async function makeRestPostRequest<T>(
	path: string,
	body?: Record<string, unknown>,
	needAuth: boolean = false
): Promise<T> {
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
		// JWT tokens are longer than legacy tokens
		const isOAuth = oAuthToken && oAuthToken.length > 50;
		const csrfToken = ( needAuth && !isOAuth ) ?
			await getCsrfToken() : null;
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

		const response = await fetchCore( buildRestApiUrl( wikiServer(), scriptPath(), path ), {
			params: enhancedParams,
			headers: headers,
			method: 'POST',
			body: enhancedBody
		} );
		const rawResponseText = await response.text();
		let data: T;
		try {
			data = JSON.parse( rawResponseText ) as T;
		} catch ( jsonError ) {
			throw new Error( `Failed to parse JSON response (POST). Raw response: ${ rawResponseText }. Error: ${ ( jsonError as Error ).message }` );
		}
		if ( data === null || data === undefined ) {
			throw new Error( `API returned no data or malformed JSON (POST). Raw response: ${ rawResponseText }` );
		}
		return data;
	} catch ( error ) {
		// For write operations, propagate HTTP errors to tools for better error messages
		// Re-throw all errors to ensure they are caught by the calling tool for proper fallback handling
		throw error;
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
