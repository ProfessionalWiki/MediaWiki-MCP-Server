import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken } from './config.js';
import { Mwn } from 'mwn';

let mwnInstance: Mwn | null = null;

export async function getMwn(): Promise<Mwn> {
	if ( mwnInstance ) {
		return mwnInstance;
	}

	mwnInstance = await Mwn.init( {
		apiUrl: `${ wikiServer() }${ scriptPath() }/api.php`,
		OAuth2AccessToken: oauthToken() || undefined,
		userAgent: USER_AGENT
	} );

	return mwnInstance;
}

export function clearMwnCache(): void {
	mwnInstance = null;
}
