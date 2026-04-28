import { Mwn, type MwnOptions } from 'mwn';
import { USER_AGENT } from '../common/userAgent.js';
import type { WikiConfig } from '../common/config.js';
import { redactAuthorizationHeader, wrapMwnErrors } from '../common/mwnErrorSanitizer.js';
import type { WikiRegistry } from './wikiRegistry.js';
import type { WikiSelection } from './wikiSelection.js';

export interface MwnProvider {
	get( wikiKey?: string ): Promise<Mwn>;
	invalidate( wikiKey: string ): void;
}

export class MwnProviderImpl implements MwnProvider {
	// Cache the Promise, not the resolved instance, so concurrent first-calls
	// for the same wiki share a single login / getSiteInfo round-trip.
	private readonly cache = new Map<string, Promise<Mwn>>();

	public constructor(
		private readonly wikis: WikiRegistry,
		private readonly selection: WikiSelection,
		private readonly getRuntimeToken: () => string | undefined
	) {}

	public async get( wikiKey?: string ): Promise<Mwn> {
		let key: string;
		let config: Readonly<WikiConfig> | undefined;
		if ( wikiKey !== undefined ) {
			key = wikiKey;
			config = this.wikis.get( wikiKey );
			if ( !config ) {
				throw new Error( `Wiki "${ wikiKey }" not found` );
			}
		} else {
			( { key, config } = this.selection.getCurrent() );
		}
		return this.getInstance( key, config );
	}

	public async getInstance( key: string, config: Readonly<WikiConfig> ): Promise<Mwn> {
		const runtimeToken = this.getRuntimeToken();
		if ( runtimeToken ) {
			return this.create( config, runtimeToken );
		}

		let pending = this.cache.get( key );
		if ( !pending ) {
			pending = this.create( config );
			this.cache.set( key, pending );
			// On failure, remove from cache so the next call retries rather than
			// permanently caching the rejected Promise.
			pending.catch( () => {
				this.cache.delete( key );
			} );
		}
		return pending;
	}

	public invalidate( key: string ): void {
		this.cache.delete( key );
	}

	private async create(
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
}
