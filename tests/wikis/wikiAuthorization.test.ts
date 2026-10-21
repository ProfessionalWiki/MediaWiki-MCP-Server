import { describe, it, expect } from 'vitest';
import { wikiAuthorization } from '../../src/wikis/wikiAuthorization.ts';
import { createMockMwn } from '../helpers/mock-mwn.ts';

const API_URL = 'https://test.wiki/w/api.php';

function signedIn() {
	return createMockMwn({
		usingOAuth2: true,
		options: { apiUrl: API_URL, OAuth2AccessToken: 'secret-token' },
	});
}

describe('wikiAuthorization', () => {
	it("sends the OAuth 2 token to a URL on the wiki's own origin", () => {
		expect(wikiAuthorization(signedIn() as never, 'https://test.wiki/w/rest.php/x')).toEqual({
			Authorization: 'Bearer secret-token',
		});
	});

	it('keeps the token from a URL on another origin', () => {
		expect(wikiAuthorization(signedIn() as never, 'https://upload.example/a.png')).toEqual({});
	});

	it('keeps the token from a URL it cannot parse', () => {
		expect(wikiAuthorization(signedIn() as never, 'not a url')).toEqual({});
	});

	// mwn itself sends a token only once it has switched to OAuth 2.
	it('adds nothing while mwn is not signing in with OAuth 2, even with a token set', () => {
		const mwn = createMockMwn({
			usingOAuth2: false,
			options: { apiUrl: API_URL, OAuth2AccessToken: 'secret-token' },
		});

		expect(wikiAuthorization(mwn as never, 'https://test.wiki/w/rest.php/x')).toEqual({});
	});
});
