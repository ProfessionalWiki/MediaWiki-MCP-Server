import { describe, it, expect } from 'vitest';
import { isAllowedRedirect } from '../../../src/auth/authorizationServer/redirectPolicy.js';

describe('isAllowedRedirect', () => {
	it.each([
		['http://127.0.0.1:9000/callback', true],
		['http://localhost:51234/oauth/callback', true],
		['https://claude.ai/api/mcp/auth_callback', true],
	])('allows %s', (u, ok) => expect(isAllowedRedirect(u as string)).toBe(ok));

	it.each([
		['http://evil.example/cb'],
		['https://claude.ai/evil'],
		['https://127.0.0.1:9000/callback'],
		['http://10.0.0.5:9000/cb'],
		['not-a-url'],
	])('rejects %s', (u) => expect(isAllowedRedirect(u as string)).toBe(false));
});
