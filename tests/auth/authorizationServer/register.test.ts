import { describe, it, expect } from 'vitest';
import { handleRegister } from '../../../src/auth/authorizationServer/register.js';
import { InMemoryProxyStore } from '../../../src/auth/authorizationServer/proxyStore.js';
import {
	buildRedirectPolicy,
	parseRedirectAllowlist,
} from '../../../src/auth/authorizationServer/redirectPolicy.js';

// The predicate a deployment actually runs with NO operator config: the source-1
// built-ins (loopback + claude.ai) PLUS the shipped client defaults. This is the
// real out-of-the-box policy, not the built-ins-only isAllowedRedirect.
const defaultPolicy = buildRedirectPolicy(parseRedirectAllowlist(undefined));

function run(body: unknown, isAllowed: (u: string) => boolean = defaultPolicy) {
	const store = new InMemoryProxyStore();
	const res = handleRegister(body, store, isAllowed);
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

describe('handleRegister with an operator allowlist', () => {
	// Real payload shapes verified against client source/docs, 2026-07-20.
	const vscode = {
		client_name: 'Visual Studio Code',
		redirect_uris: [
			'https://insiders.vscode.dev/redirect',
			'https://vscode.dev/redirect',
			'http://127.0.0.1/',
			'http://127.0.0.1:33418/',
		],
		token_endpoint_auth_method: 'none',
	};
	const cursor = {
		client_name: 'Cursor',
		redirect_uris: [
			'cursor://anysphere.cursor-mcp/oauth/callback',
			'https://www.cursor.com/agents/mcp/oauth/callback',
			'http://localhost:8787/callback',
		],
	};
	const chatgpt = {
		client_name: 'ChatGPT',
		redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
	};
	const operatorPolicy = buildRedirectPolicy(
		parseRedirectAllowlist(
			'https://insiders.vscode.dev/redirect,https://vscode.dev/redirect,' +
				'cursor://anysphere.cursor-mcp/oauth/callback,https://www.cursor.com/agents/mcp/oauth/callback,' +
				'https://chatgpt.com/connector/oauth/*',
		),
	);

	it('a non-vendor host is still rejected under the real default policy', () => {
		const { res } = run({ client_name: 'Evil', redirect_uris: ['https://evil.example/cb'] });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');
	});

	it('Cursor is accepted under the real default policy (no operator config)', () => {
		// The real 3-URI payload (hosted callback, cursor:// desktop callback, and a
		// loopback fallback) registers with no MCP_OAUTH_ALLOWED_REDIRECTS.
		expect(run(cursor).res.status).toBe(201);
	});

	it('ChatGPT is accepted under the real default policy (no operator config)', () => {
		// The real per-connector payload registers with no MCP_OAUTH_ALLOWED_REDIRECTS.
		expect(run(chatgpt).res.status).toBe(201);
		// The per-connector prefix absorbs connector-id churn.
		expect(
			run({
				client_name: 'ChatGPT',
				redirect_uris: ['https://chatgpt.com/connector/oauth/xyz789'],
			}).res.status,
		).toBe(201);
		// The legacy already-published exact callback is covered too.
		expect(
			run({
				client_name: 'ChatGPT',
				redirect_uris: ['https://chatgpt.com/connector_platform_oauth_redirect'],
			}).res.status,
		).toBe(201);
	});

	it.each([
		['VS Code', vscode],
		['Cursor', cursor],
		['ChatGPT', chatgpt],
	])('%s payload passes under a matching allowlist', (_n, body) => {
		expect(run(body, operatorPolicy).res.status).toBe(201);
	});

	it('rejects a registration mixing an allowed and a disallowed redirect_uri', () => {
		const { res } = run(
			{
				client_name: 'Mixed',
				redirect_uris: ['https://vscode.dev/redirect', 'https://evil.example/cb'],
			},
			operatorPolicy,
		);
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');
	});
});
