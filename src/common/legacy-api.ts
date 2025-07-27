/**
 * Legacy MediaWiki Action API utilities
 *
 * This module provides functions for interacting with MediaWiki's legacy Action API
 * as a workaround for OAuth 2.0 + REST API CSRF token issues.
 *
 * Issue: The REST API doesn't properly recognize OAuth 2.0 Bearer tokens as CSRF-safe,
 * but the legacy Action API works correctly with OAuth 2.0 authentication.
 */

import { scriptPath, wikiServer, oauthToken, wikiLanguage } from './config.js';
import { USER_AGENT } from '../server.js';
import fetch from 'node-fetch';

/**
 * Make a legacy Action API request with OAuth 2.0 authentication
 *
 * @param params
 * @param needAuth
 */
export async function makeLegacyApiRequest<T>(
	params: Record<string, string>,
	needAuth: boolean = false
): Promise<T | null> {
	try {
		const baseUrl = `${ wikiServer() }${ scriptPath() }/api.php`;

		const headers: Record<string, string> = {
			'User-Agent': USER_AGENT,
			Accept: 'application/json',
			'Accept-Language': wikiLanguage()
		};

		// Add OAuth 2.0 Bearer token if authentication is needed
		const token = oauthToken();
		if ( needAuth && token ) {
			headers.Authorization = `Bearer ${ token }`;
		}

		// Add format and language to params
		const enhancedParams = {
			...params,
			format: 'json',
			uselang: wikiLanguage()
		};

		const queryString = new URLSearchParams( enhancedParams ).toString();
		const url = `${ baseUrl }?${ queryString }`;

		const response = await fetch( url, {
			headers,
			method: 'GET'
		} );

		if ( !response.ok ) {
			const errorBody = await response.text().catch( () => 'Could not read error response body' );
			throw new Error(
				`HTTP error! status: ${ response.status } for URL: ${ response.url }. Response: ${ errorBody }`
			);
		}

		return ( await response.json() ) as T;
	} catch ( error ) {
		console.error( 'Error making legacy API request:', error );
		return null;
	}
}

/**
 * Make a legacy Action API POST request with OAuth 2.0 authentication
 *
 * @param params
 * @param needAuth
 */
export async function makeLegacyApiPostRequest<T>(
	params: Record<string, string>,
	needAuth: boolean = false
): Promise<T | null> {
	try {
		const baseUrl = `${ wikiServer() }${ scriptPath() }/api.php`;

		const headers: Record<string, string> = {
			'User-Agent': USER_AGENT,
			Accept: 'application/json',
			'Accept-Language': wikiLanguage(),
			'Content-Type': 'application/x-www-form-urlencoded'
		};

		// Add OAuth 2.0 Bearer token if authentication is needed
		const token = oauthToken();
		if ( needAuth && token ) {
			headers.Authorization = `Bearer ${ token }`;
		}

		// Add format and language to params
		const enhancedParams = {
			...params,
			format: 'json',
			uselang: wikiLanguage()
		};

		const response = await fetch( baseUrl, {
			method: 'POST',
			headers,
			body: new URLSearchParams( enhancedParams )
		} );

		if ( !response.ok ) {
			const errorBody = await response.text().catch( () => 'Could not read error response body' );
			throw new Error(
				`HTTP error! status: ${ response.status } for URL: ${ response.url }. Response: ${ errorBody }`
			);
		}

		return ( await response.json() ) as T;
	} catch ( error ) {
		// For write operations, propagate HTTP errors to tools for better error messages
		if ( error instanceof Error && error.message.includes( 'HTTP error!' ) ) {
			throw error;
		}
		console.error( 'Error making legacy API POST request:', error );
		return null;
	}
}

/**
 * Get CSRF token using legacy Action API
 * This always works with OAuth 2.0, unlike the REST API
 */
export async function getLegacyCsrfToken(): Promise<string | null> {
	try {
		const response = await makeLegacyApiRequest<{
			query?: {
				tokens?: {
					csrftoken?: string;
				};
			};
		}>( {
			action: 'query',
			meta: 'tokens',
			type: 'csrf'
		}, true );

		const csrfToken = response?.query?.tokens?.csrftoken;
		if ( csrfToken && csrfToken !== '+\\\\' ) {
			return csrfToken;
		}

		console.error( 'No valid CSRF token in legacy API response:', response );
		return null;
	} catch ( error ) {
		console.error( 'Error fetching CSRF token via legacy API:', error );
		return null;
	}
}

/**
 * Create a page using legacy Action API as workaround for REST API OAuth issues
 *
 * @param title
 * @param content
 * @param summary
 * @param contentModel
 */
export async function createPageLegacy(
	title: string,
	content: string,
	summary?: string,
	contentModel: string = 'wikitext'
): Promise<{
		success: boolean;
		pageid?: number;
		title?: string;
		newrevid?: number;
		error?: string;
	}> {
	try {
		// Get CSRF token first
		const csrfToken = await getLegacyCsrfToken();
		if ( !csrfToken ) {
			return { success: false, error: 'Failed to obtain CSRF token' };
		}

		// Create page using legacy Action API
		const response = await makeLegacyApiPostRequest<{
			edit?: {
				result?: string;
				pageid?: number;
				title?: string;
				newrevid?: number;
			};
			error?: {
				code?: string;
				info?: string;
			};
		}>( {
			action: 'edit',
			title,
			text: content,
			summary: summary || 'Created via MediaWiki MCP Server',
			contentmodel: contentModel,
			token: csrfToken
		}, true );

		if ( response?.edit?.result === 'Success' ) {
			return {
				success: true,
				pageid: response.edit.pageid,
				title: response.edit.title,
				newrevid: response.edit.newrevid
			};
		} else if ( response?.error ) {
			return {
				success: false,
				error: `${ response.error.code }: ${ response.error.info }`
			};
		} else {
			return {
				success: false,
				error: 'Unknown error creating page via legacy API'
			};
		}
	} catch ( error ) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}

/**
 * Update a page using legacy Action API as workaround for REST API OAuth issues
 *
 * @param title
 * @param content
 * @param summary
 * @param latestRevisionId
 */
export async function updatePageLegacy(
	title: string,
	content: string,
	summary?: string,
	latestRevisionId?: number
): Promise<{
		success: boolean;
		pageid?: number;
		title?: string;
		newrevid?: number;
		error?: string;
	}> {
	try {
		// Get CSRF token first
		const csrfToken = await getLegacyCsrfToken();
		if ( !csrfToken ) {
			return { success: false, error: 'Failed to obtain CSRF token' };
		}

		// Build edit parameters
		const editParams: Record<string, string> = {
			action: 'edit',
			title,
			text: content,
			summary: summary || 'Updated via MediaWiki MCP Server',
			token: csrfToken
		};

		// Add baserevid for edit conflict protection if provided
		if ( latestRevisionId ) {
			editParams.baserevid = latestRevisionId.toString();
		}

		// Update page using legacy Action API
		const response = await makeLegacyApiPostRequest<{
			edit?: {
				result?: string;
				pageid?: number;
				title?: string;
				newrevid?: number;
			};
			error?: {
				code?: string;
				info?: string;
			};
		}>( editParams, true );

		if ( response?.edit?.result === 'Success' ) {
			return {
				success: true,
				pageid: response.edit.pageid,
				title: response.edit.title,
				newrevid: response.edit.newrevid
			};
		} else if ( response?.error ) {
			return {
				success: false,
				error: `${ response.error.code }: ${ response.error.info }`
			};
		} else {
			return {
				success: false,
				error: 'Unknown error updating page via legacy API'
			};
		}
	} catch ( error ) {
		return {
			success: false,
			error: error instanceof Error ? error.message : 'Unknown error'
		};
	}
}
