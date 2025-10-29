import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken, username, password } from './config.js';
import { Mwn, MwnOptions } from 'mwn';

let mwnInstance: Mwn | null = null;

export async function getMwn(): Promise<Mwn> {
	if ( mwnInstance ) {
		return mwnInstance;
	}

	const token = oauthToken();
	const user = username();
	const pass = password();

	const options: MwnOptions = {
		apiUrl: `${ wikiServer() }${ scriptPath() }/api.php`,
		userAgent: USER_AGENT
	};

	if ( token ) {
		options.OAuth2AccessToken = token;
		mwnInstance = await Mwn.init( options );
	} else if ( user && pass ) {
		options.username = user;
		options.password = pass;
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
