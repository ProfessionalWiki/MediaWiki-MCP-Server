import { describe, expect, it } from 'vitest';
import {
	mwOauth2AuthorizeEndpoint,
	mwOauth2TokenEndpoint,
} from '../../src/auth/mwOauth2Endpoints.js';

describe('mwOauth2Endpoints', () => {
	it('builds the access_token endpoint from base + scriptpath', () => {
		expect(mwOauth2TokenEndpoint('https://wiki.example', '/w')).toBe(
			'https://wiki.example/w/rest.php/oauth2/access_token',
		);
	});

	it('builds the authorize endpoint from base + scriptpath', () => {
		expect(mwOauth2AuthorizeEndpoint('http://mediawiki.svc:8080', '/w')).toBe(
			'http://mediawiki.svc:8080/w/rest.php/oauth2/authorize',
		);
	});

	it('handles a root scriptpath', () => {
		expect(mwOauth2TokenEndpoint('https://wiki.example', '')).toBe(
			'https://wiki.example/rest.php/oauth2/access_token',
		);
		expect(mwOauth2AuthorizeEndpoint('https://wiki.example', '')).toBe(
			'https://wiki.example/rest.php/oauth2/authorize',
		);
	});
});
