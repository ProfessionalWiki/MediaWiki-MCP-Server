export class WikiDiscoveryError extends Error {
	public constructor( message: string ) {
		super( message );
		this.name = 'WikiDiscoveryError';
	}
}
