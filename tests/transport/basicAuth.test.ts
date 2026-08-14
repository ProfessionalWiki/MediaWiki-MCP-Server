import { describe, it, expect } from 'vitest';

import type { Request } from 'express';
import { readBasicAuthHeader } from '../../src/transport/basicAuth.ts';
import { basicAuthEnabled } from '../../src/runtime/authShape.ts';

function req(authorization: string | undefined): Request {
	return { headers: { authorization } } as unknown as Request;
}

function encode(value: string): string {
	return Buffer.from(value, 'utf8').toString('base64');
}

describe('readBasicAuthHeader', () => {
	it('reads a username and password out of a standard Basic header', () => {
		expect(readBasicAuthHeader(req(`Basic ${encode('Alice@mcp:s3cret')}`))).toEqual({
			kind: 'credentials',
			credentials: { username: 'Alice@mcp', password: 's3cret' },
		});
	});

	it('is case-insensitive on the scheme and tolerates surrounding whitespace', () => {
		const encoded = encode('Alice@mcp:s3cret');
		expect(readBasicAuthHeader(req(`basic ${encoded}`)).kind).toBe('credentials');
		expect(readBasicAuthHeader(req(`BASIC  ${encoded}  `)).kind).toBe('credentials');
	});

	it('splits on the first colon only, so a password may contain one', () => {
		expect(readBasicAuthHeader(req(`Basic ${encode('Alice@mcp:a:b:c')}`))).toEqual({
			kind: 'credentials',
			credentials: { username: 'Alice@mcp', password: 'a:b:c' },
		});
	});

	it('decodes non-ASCII credentials as UTF-8', () => {
		expect(readBasicAuthHeader(req(`Basic ${encode('김영제:비밀번호')}`))).toEqual({
			kind: 'credentials',
			credentials: { username: '김영제', password: '비밀번호' },
		});
	});

	it('reports no Basic credentials when the header is missing or another scheme', () => {
		expect(readBasicAuthHeader(req(undefined)).kind).toBe('absent');
		expect(readBasicAuthHeader(req('Bearer abc123')).kind).toBe('absent');
		expect(readBasicAuthHeader(req('Digest xyz')).kind).toBe('absent');
	});

	it('takes the first value from comma-joined duplicate headers', () => {
		const first = encode('First@mcp:one');
		const second = encode('Second@mcp:two');
		expect(readBasicAuthHeader(req(`Basic ${first}, Basic ${second}`))).toEqual({
			kind: 'credentials',
			credentials: { username: 'First@mcp', password: 'one' },
		});
	});

	// Each of these is a caller that MEANT to authenticate. Reporting them as
	// absent would run the request anonymously under an identity it does not have.
	it('reports a Basic header carrying nothing usable as malformed', () => {
		expect(readBasicAuthHeader(req('Basic')).kind).toBe('malformed');
		expect(readBasicAuthHeader(req('Basic ')).kind).toBe('malformed');
		expect(readBasicAuthHeader(req('Basic not-base64!')).kind).toBe('malformed');
		expect(readBasicAuthHeader(req(`Basic ${encode('nocolon')}`)).kind).toBe('malformed');
		expect(readBasicAuthHeader(req(`Basic ${encode(':password')}`)).kind).toBe('malformed');
		expect(readBasicAuthHeader(req(`Basic ${encode('username:')}`)).kind).toBe('malformed');
	});

	it('reports url-safe base64 as malformed rather than decoding it to garbage', () => {
		// Buffer.from discards out-of-alphabet characters silently, so a value in
		// the url-safe alphabet would otherwise decode to a plausible-looking pair
		// with bytes missing from the middle of it.
		expect(readBasicAuthHeader(req('Basic QWxpY2VAbWNwOnMzY3JldD-_')).kind).toBe('malformed');
	});
});

describe('basicAuthEnabled', () => {
	it('is on unless the operator turns it off', () => {
		expect(basicAuthEnabled({})).toBe(true);
		expect(basicAuthEnabled({ MCP_ALLOW_BASIC_AUTH: 'true' })).toBe(true);
		expect(basicAuthEnabled({ MCP_ALLOW_BASIC_AUTH: 'false' })).toBe(false);
	});
});
