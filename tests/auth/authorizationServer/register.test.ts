import { describe, it, expect } from 'vitest';
import { handleRegister } from '../../../src/auth/authorizationServer/register.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';

function run(body: unknown) {
	const store = new InMemoryProxyStore();
	const res = handleRegister(body, store);
	return { res, store };
}

describe('handleRegister', () => {
	it('registers a loopback client', () => {
		const { res } = run({
			redirect_uris: ['http://127.0.0.1:9000/callback'],
			client_name: 'Claude Code',
			grant_types: ['authorization_code'],
		});
		expect(res.status).toBe(201);
		expect(res.body.client_id).toMatch(/^mcp-/);
		expect(res.body.token_endpoint_auth_method).toBe('none');
		expect(res.body.redirect_uris).toEqual(['http://127.0.0.1:9000/callback']);
	});

	it('rejects a disallowed redirect', () => {
		const { res } = run({ redirect_uris: ['https://evil.example/cb'] });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');
	});

	it('rejects empty redirect_uris', () => {
		const { res } = run({ redirect_uris: [] });
		expect(res.status).toBe(400);
	});

	it('rejects missing redirect_uris', () => {
		const { res } = run({ client_name: 'No redirects' });
		expect(res.status).toBe(400);
	});

	it('accepts authorization_code alone in grant_types', () => {
		const { res } = run({
			redirect_uris: ['http://127.0.0.1:9000/cb'],
			grant_types: ['authorization_code'],
		});
		expect(res.status).toBe(201);
	});

	it('rejects more than the per-record redirect_uri cap', () => {
		const many = Array.from({ length: 11 }, (_, i) => `http://127.0.0.1:${9000 + i}/cb`);
		const { res } = run({ redirect_uris: many });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');
	});

	it('dedupes repeated redirect_uris', () => {
		const { res } = run({
			redirect_uris: ['http://127.0.0.1:9000/cb', 'http://127.0.0.1:9000/cb'],
		});
		expect(res.status).toBe(201);
		expect(res.body.redirect_uris).toEqual(['http://127.0.0.1:9000/cb']);
	});

	it('truncates an over-long client_name', () => {
		const { res } = run({
			redirect_uris: ['http://127.0.0.1:9000/cb'],
			client_name: 'x'.repeat(300),
		});
		expect(res.status).toBe(201);
		expect((res.body.client_name as string).length).toBe(256);
	});
});
