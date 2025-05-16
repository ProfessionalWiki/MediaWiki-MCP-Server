import fetch from 'node-fetch';
import { SERVER_NAME, SERVER_VERSION } from '../server.js';

const USER_AGENT: string = `${ SERVER_NAME }/${ SERVER_VERSION }`;

export async function makeApiRequest<T>(
	apiBase: string,
	path: string,
	params?: Record<string, string>
): Promise<T | null> {
	const headers = {
		'User-Agent': USER_AGENT,
		Accept: 'application/json'
	};

	let url = `${ apiBase }${ path }`;

	if ( params ) {
		url = url + '?' + new URLSearchParams( params ).toString();
	}

	try {
		const response = await fetch( url, { headers } );
		if ( !response.ok ) {
			throw new Error( `HTTP error! status: ${ response.status }` );
		}
		return ( await response.json() ) as T;
	} catch ( error ) {
		console.error( 'Error making API request:', error );
		return null;
	}
}
