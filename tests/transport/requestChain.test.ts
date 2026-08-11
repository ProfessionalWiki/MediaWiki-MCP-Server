import { describe, it, expect } from 'vitest';
import {
	firstRequest,
	nextHop,
	InsecureRedirectError,
	MAX_REDIRECTS,
	RedirectDropsBodyError,
	TooManyRedirectsError,
	UnusableLocationError,
	type HopRequest,
} from '../../src/transport/requestChain.ts';

const START = 'https://wiki.example/w/api.php';

function sent(overrides: Partial<HopRequest> = {}): HopRequest {
	return { ...firstRequest(START), ...overrides };
}

function got(
	status: number,
	location: string | null = '/moved',
): { status: number; location: string | null } {
	return { status, location };
}

describe('firstRequest', () => {
	it('derives GET from the absence of a body', () => {
		expect(firstRequest(START).method).toBe('GET');
	});

	it('derives POST from the presence of a body', () => {
		const request = firstRequest(START, { body: 'query=x' });

		expect(request.method).toBe('POST');
		expect(request.body).toBe('query=x');
	});

	it('treats an empty body as a body, so it travels as a POST', () => {
		expect(firstRequest(START, { body: '' }).method).toBe('POST');
	});

	it('reads a protocol-relative URL as https', () => {
		expect(firstRequest('//wiki.example/w/api.php').url).toBe(START);
	});

	it('applies the params to the url before anything is sent', () => {
		expect(firstRequest(START, { params: { action: 'query' } }).url).toBe(`${START}?action=query`);
	});

	it('starts the chain at the url it was given', () => {
		const request = firstRequest(START, { params: { action: 'query' } });

		expect(request.redirectsFollowed).toBe(0);
		expect(request.startUrl).toBe(request.url);
	});
});

describe('which statuses are a redirect', () => {
	it.each([301, 302, 303, 307, 308])('follows a %i that carries a Location', (status) => {
		expect(nextHop(sent(), got(status)).kind).toBe('follow');
	});

	// 300 offers a choice and 305 names a proxy: neither is a destination.
	it.each([300, 304, 305, 306, 309])('delivers a %i even when it carries a Location', (status) => {
		expect(nextHop(sent(), got(status)).kind).toBe('deliver');
	});

	it('delivers a redirect status that carries no Location', () => {
		expect(nextHop(sent(), got(302, null)).kind).toBe('deliver');
	});

	it('delivers a 2xx', () => {
		expect(nextHop(sent(), got(200, null)).kind).toBe('deliver');
	});
});

describe('the request the next hop sends', () => {
	it('resolves a path-only Location against the hop that sent it', () => {
		const decision = nextHop(sent(), got(302, '/elsewhere/api.php'));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { url: 'https://wiki.example/elsewhere/api.php' },
		});
	});

	it('resolves a protocol-relative Location against the scheme in use', () => {
		const decision = nextHop(sent(), got(302, '//other.example/api.php'));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { url: 'https://other.example/api.php' },
		});
	});

	// A relative Location belongs to the hop that sent it, not to the start.
	it('resolves a path-only Location against the current hop, not the start of the chain', () => {
		const secondHop = sent({
			url: 'https://moved.example/a/b',
			redirectsFollowed: 1,
		});

		const decision = nextHop(secondHop, got(302, '/c'));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { url: 'https://moved.example/c' },
		});
	});

	it('counts the hop, so a chain can be capped', () => {
		const decision = nextHop(sent({ redirectsFollowed: 2 }), got(302));

		expect(decision).toMatchObject({ kind: 'follow', request: { redirectsFollowed: 3 } });
	});

	it('keeps the start url across the chain, so the cap can name where it began', () => {
		const decision = nextHop(sent({ redirectsFollowed: 2 }), got(302));

		expect(decision).toMatchObject({ kind: 'follow', request: { startUrl: START } });
	});

	it('re-sends the method and body across a 307', () => {
		const decision = nextHop(sent({ ...firstRequest(START, { body: 'query=x' }) }), got(307));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { method: 'POST', body: 'query=x' },
		});
	});
});

describe('credential headers across a hop', () => {
	const withCredentials = () =>
		sent({
			headers: {
				Authorization: 'Bearer secret',
				Cookie: 'session=secret',
				'WWW-Authenticate': 'Basic',
				Accept: 'application/json',
			},
		});

	it('keeps them on a hop that stays on the same origin', () => {
		const decision = nextHop(withCredentials(), got(302, '/elsewhere'));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { headers: { Authorization: 'Bearer secret', Cookie: 'session=secret' } },
		});
	});

	it('drops them on a hop to another host', () => {
		const decision = nextHop(withCredentials(), got(302, 'https://other.example/x'));

		expect(decision).toMatchObject({ kind: 'follow' });
		const headers = (decision as { request: HopRequest }).request.headers;
		expect(headers).not.toHaveProperty('Authorization');
		expect(headers).not.toHaveProperty('Cookie');
		expect(headers).not.toHaveProperty('WWW-Authenticate');
	});

	// node-fetch's own rule would forward the credentials to a subdomain.
	it('drops them on a hop to a subdomain of the same host', () => {
		const decision = nextHop(withCredentials(), got(302, 'https://tenant.wiki.example/x'));

		expect((decision as { request: HopRequest }).request.headers).not.toHaveProperty(
			'Authorization',
		);
	});

	it('drops them on a hop that only changes the port', () => {
		const decision = nextHop(withCredentials(), got(302, 'https://wiki.example:8443/x'));

		expect((decision as { request: HopRequest }).request.headers).not.toHaveProperty(
			'Authorization',
		);
	});

	it('keeps a header that is not a credential across a change of host', () => {
		const decision = nextHop(withCredentials(), got(302, 'https://other.example/x'));

		expect(decision).toMatchObject({
			kind: 'follow',
			request: { headers: { Accept: 'application/json' } },
		});
	});
});

describe('the hops it refuses', () => {
	it('refuses to drop a body a 301, 302 or 303 would discard', () => {
		const withBody = sent(firstRequest(START, { body: 'query=x' }));

		for (const status of [301, 302, 303]) {
			const decision = nextHop(withBody, got(status, '/moved'));

			expect(decision).toMatchObject({ kind: 'refuse' });
			const error = (decision as { error: Error }).error;
			expect(error).toBeInstanceOf(RedirectDropsBodyError);
			expect((error as RedirectDropsBodyError).status).toBe(status);
			expect((error as RedirectDropsBodyError).target).toBe('https://wiki.example/moved');
		}
	});

	it('refuses a hop from https to http, body or no body', () => {
		const decision = nextHop(sent(), got(302, 'http://wiki.example/x'));

		expect(decision).toMatchObject({ kind: 'refuse' });
		const error = (decision as { error: Error }).error;
		expect(error).toBeInstanceOf(InsecureRedirectError);
		expect((error as InsecureRedirectError).target).toBe('http://wiki.example/x');
	});

	it('allows a hop from http to https, which loses nothing', () => {
		const fromHttp = sent(firstRequest('http://wiki.example/w/api.php'));

		expect(nextHop(fromHttp, got(302, 'https://wiki.example/x')).kind).toBe('follow');
	});

	it('reports an insecure hop as insecure even when it also drops a body', () => {
		const withBody = sent(firstRequest(START, { body: 'query=x' }));

		expect(
			(nextHop(withBody, got(303, 'http://wiki.example/x')) as { error: Error }).error,
		).toBeInstanceOf(InsecureRedirectError);
	});

	it('refuses a Location that is not a URL', () => {
		const decision = nextHop(sent(), got(302, 'http://['));

		expect(decision).toMatchObject({ kind: 'refuse' });
		expect((decision as { error: Error }).error).toBeInstanceOf(UnusableLocationError);
	});

	it('refuses the hop after the last one it will follow, naming where the chain began', () => {
		const decision = nextHop(sent({ redirectsFollowed: MAX_REDIRECTS }), got(302));

		expect(decision).toMatchObject({ kind: 'refuse' });
		const error = (decision as { error: Error }).error;
		expect(error).toBeInstanceOf(TooManyRedirectsError);
		expect((error as TooManyRedirectsError).startUrl).toBe(START);
	});

	it('follows the last hop within the cap', () => {
		expect(nextHop(sent({ redirectsFollowed: MAX_REDIRECTS - 1 }), got(302)).kind).toBe('follow');
	});

	// The cap is read before the target, so a long chain is reported as long.
	it('reports the cap ahead of a body-dropping hop', () => {
		const withBody = sent({
			...firstRequest(START, { body: 'query=x' }),
			redirectsFollowed: MAX_REDIRECTS,
		});

		expect((nextHop(withBody, got(303)) as { error: Error }).error).toBeInstanceOf(
			TooManyRedirectsError,
		);
	});
});

describe('what a refusal keeps out of its message', () => {
	// These URLs can carry a credential, and a message reaches the caller and the logs.
	it.each([
		new RedirectDropsBodyError(303, 'https://q.example/sparql?token=hunter2'),
		new InsecureRedirectError(302, 'http://q.example/sparql?token=hunter2'),
	])('keeps the target out of $name', (error) => {
		expect(error.message).not.toContain('hunter2');
		expect(error.message).not.toContain('q.example');
		expect(error.target).toContain('hunter2');
	});
});
