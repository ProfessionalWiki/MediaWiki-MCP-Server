import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken } from './config.js';
import { Mwn } from 'mwn';

export async function getMwn(): Promise<Mwn> {
	return await Mwn.init( {
		apiUrl: `${ wikiServer() }${ scriptPath() }/api.php`,
		OAuth2AccessToken: oauthToken() || undefined,
		userAgent: USER_AGENT
	} );
}
