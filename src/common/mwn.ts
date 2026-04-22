import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import type { WikiConfig } from './config.js';
import { Mwn, MwnOptions } from 'mwn';
import { getRuntimeToken } from './requestContext.js';

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
	const effectiveToken = runtimeToken ?? token;

	const options: MwnOptions = {
		apiUrl: `${ server }${ scriptpath }/api.php`,
		userAgent: USER_AGENT
	};

	try {
		if ( effectiveToken ) {
			options.OAuth2AccessToken = effectiveToken;
			return await Mwn.init( options );
		}

		if ( username && password ) {
			options.username = username;
			options.password = password;
			return await Mwn.init( options );
		}

		const instance = new Mwn( options );
		await instance.getSiteInfo();
		return instance;
	} catch ( error: unknown ) {
		if ( error instanceof Error ) {
			// mwn/axios attach full request config (incl. Authorization header)
			// to error objects — strip to prevent token leaks in logs/responses
			delete ( error as unknown as Record<string, unknown> ).request;
			delete ( error as unknown as Record<string, unknown> ).config;
			delete ( error as unknown as Record<string, unknown> ).response;
			if ( effectiveToken && error.message.includes( effectiveToken ) ) {
				error.message = error.message.replaceAll( effectiveToken, '[REDACTED]' );
			}
		}
		throw error;
	}
}

export function removeMwnInstance( wikiKey: string ): void {
	mwnInstances.delete( wikiKey );
}
