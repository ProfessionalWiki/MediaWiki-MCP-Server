import type { Mwn } from 'mwn';

// `rawRequest` skips mwn's own authentication, so a raw request adds the OAuth 2
// bearer itself, and only to a URL on the wiki's own origin: the token must not
// reach another host a URL points at, such as a file repository's CDN.
// Bot-password cookies travel with mwn's HTTP client either way.
export function wikiAuthorization(mwn: Mwn, url: string | undefined): Record<string, string> {
	const token = mwn.options.OAuth2AccessToken;
	if (!mwn.usingOAuth2 || typeof token !== 'string' || !onOrigin(url, mwn.options.apiUrl)) {
		return {};
	}
	return { Authorization: `Bearer ${token}` };
}

function onOrigin(url: string | undefined, apiUrl: string | undefined): boolean {
	if (url === undefined || apiUrl === undefined) {
		return false;
	}
	try {
		return new URL(url).origin === new URL(apiUrl).origin;
	} catch {
		return false;
	}
}
