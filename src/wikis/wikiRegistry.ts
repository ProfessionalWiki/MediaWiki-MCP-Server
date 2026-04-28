import type { WikiConfig } from '../common/config.js';

export interface WikiRegistry {
	getAll(): Readonly<Record<string, WikiConfig>>;
	get( key: string ): Readonly<WikiConfig> | undefined;
	add( key: string, config: WikiConfig ): void;
	remove( key: string ): void;
	isManagementAllowed(): boolean;
}

export class DuplicateWikiKeyError extends Error {
	public constructor( key: string ) {
		super( `Wiki "${ key }" already exists in configuration` );
		this.name = 'DuplicateWikiKeyError';
	}
}

export class WikiRegistryImpl implements WikiRegistry {
	public constructor(
		private readonly wikis: Record<string, WikiConfig>,
		private readonly managementAllowed: boolean
	) {}

	public getAll(): Readonly<Record<string, WikiConfig>> {
		return this.wikis;
	}

	public get( key: string ): Readonly<WikiConfig> | undefined {
		return this.wikis[ key ];
	}

	public add( key: string, config: WikiConfig ): void {
		if ( !key || key.trim() === '' ) {
			throw new Error( 'Wiki key cannot be empty' );
		}
		if ( this.wikis[ key ] ) {
			throw new DuplicateWikiKeyError( key );
		}
		this.wikis[ key ] = config;
	}

	public remove( key: string ): void {
		delete this.wikis[ key ];
	}

	public isManagementAllowed(): boolean {
		return this.managementAllowed;
	}
}
