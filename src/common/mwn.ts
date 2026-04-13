import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import { Mwn, MwnOptions } from 'mwn';

const mwnInstances = new Map<string, Mwn>();

export async function getMwn(): Promise<Mwn> {
	const { key, config } = wikiService.getCurrent();

	const existing = mwnInstances.get( key );
	if ( existing ) {
		return existing;
	}

	const {
		server,
		scriptpath,
		token,
		username,
		password
	} = config;

	const options: MwnOptions = {
		apiUrl: `${ server }${ scriptpath }/api.php`,
		userAgent: USER_AGENT
	};

	let instance: Mwn;

	if ( token ) {
		options.OAuth2AccessToken = token;
		instance = await Mwn.init( options );
	} else if ( username && password ) {
		options.username = username;
		options.password = password;
		instance = await Mwn.init( options );
	} else {
		instance = new Mwn( options );
		await instance.getSiteInfo();
	}

	mwnInstances.set( key, instance );
	return instance;
}

export function removeMwnInstance( wikiKey: string ): void {
	mwnInstances.delete( wikiKey );
}
