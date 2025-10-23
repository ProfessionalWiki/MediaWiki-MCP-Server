import { USER_AGENT } from '../server.js';
import { scriptPath, wikiServer, oauthToken, username, password } from './config.js';
import { Mwn } from 'mwn';

let mwnInstance: Mwn | null = null;

export async function getMwn(): Promise<Mwn> {
	if ( mwnInstance ) {
		return mwnInstance;
	}

	const token = oauthToken();
	const user = username();
	const pass = password();

	const useOAuth = !!token;
	const useUsernamePassword = !useOAuth && !!user && !!pass;

	mwnInstance = await Mwn.init( {
		apiUrl: `${ wikiServer() }${ scriptPath() }/api.php`,
		OAuth2AccessToken: useOAuth ? token : undefined,
		username: useUsernamePassword ? user : undefined,
		password: useUsernamePassword ? pass : undefined,
		userAgent: USER_AGENT
	} );

	return mwnInstance;
}

export function clearMwnCache(): void {
	mwnInstance = null;
}
