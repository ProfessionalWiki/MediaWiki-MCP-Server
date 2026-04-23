import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import type { WikiConfig } from './config.js';
import { Mwn, MwnOptions } from 'mwn';
import { getRuntimeToken } from './requestContext.js';
import { redactAuthorizationHeader, wrapMwnErrors } from './mwnErrorSanitizer.js';

// Cache the Promise, not the resolved instance, so concurrent first-calls
// for the same wiki share a single login / getSiteInfo round-trip.
const mwnInstances = new Map<string, Promise<Mwn>>();

export async function getMwn( wikiKey?: string ): Promise<Mwn> {
	let key: string;
	let config: Readonly<WikiConfig> | undefined;

	if ( wikiKey !== undefined ) {
		key = wikiKey;
		config = wikiService.get( wikiKey );
		if ( !config ) {
			throw new Error( `Wiki "${ wikiKey }" not found` );
		}
	} else {
		( { key, config } = wikiService.getCurrent() );
	}

	const runtimeToken = getRuntimeToken();
	if ( runtimeToken ) {
		return createMwnInstance( config, runtimeToken );
	}

	let pending = mwnInstances.get( key );
	if ( !pending ) {
		pending = createMwnInstance( config );
		mwnInstances.set( key, pending );
		// On failure, remove from cache so the next call retries rather than
		// permanently caching the rejected Promise.
		pending.catch( () => {
			mwnInstances.delete( key );
		} );
	}
	return pending;
}

async function createMwnInstance(
	config: Readonly<WikiConfig>,
	runtimeToken?: string
): Promise<Mwn> {
	const { server, scriptpath, token, username, password } = config;
	const effectiveToken: string | undefined = runtimeToken ?? token ?? undefined;

	const options: MwnOptions = {
		apiUrl: `${ server }${ scriptpath }/api.php`,
		userAgent: USER_AGENT
	};

	let instance: Mwn;
	try {
		if ( effectiveToken ) {
			options.OAuth2AccessToken = effectiveToken;
			instance = await Mwn.init( options );
		} else if ( username && password ) {
			options.username = username;
			options.password = password;
			instance = await Mwn.init( options );
		} else {
			instance = new Mwn( options );
			await instance.getSiteInfo();
		}
	} catch ( error: unknown ) {
		redactAuthorizationHeader( error, effectiveToken );
		throw error;
	}

	return wrapMwnErrors( instance, effectiveToken );
}

export function removeMwnInstance( wikiKey: string ): void {
	mwnInstances.delete( wikiKey );
}
