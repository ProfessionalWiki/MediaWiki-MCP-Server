import { USER_AGENT } from '../server.js';
import { wikiService } from './wikiService.js';
import { Mwn, MwnOptions } from 'mwn';

let mwnInstance: Mwn | null = null;

export async function getMwn(): Promise<Mwn> {
	if ( mwnInstance ) {
		return mwnInstance;
	}

	const {
		server,
		scriptpath,
		token,
		username,
		password
	} = wikiService.getCurrent().config;

	const options: MwnOptions = {
		apiUrl: `${ server }${ scriptpath }/api.php`,
		userAgent: USER_AGENT
	};

	if ( token ) {
		options.OAuth2AccessToken = token;
		mwnInstance = await Mwn.init( options );
	} else if ( username && password ) {
		options.username = username;
		options.password = password;
		mwnInstance = await Mwn.init( options );
	} else {
		mwnInstance = new Mwn( options );
		await mwnInstance.getSiteInfo();
	}

	return mwnInstance;
}

export function clearMwnCache(): void {
	mwnInstance = null;
}
