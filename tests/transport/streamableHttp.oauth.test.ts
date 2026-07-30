import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import express, { type Express } from 'express';
import request from 'supertest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createOAuthProtectedResourceHandler } from '../../src/transport/streamableHttp.ts';
import { createMcpRouteHandler, type McpRouteOptions } from '../../src/transport/mcpRoute.ts';
import { AUTHENTICATION_REQUIRED_ERROR_CODE } from '../../src/transport/errorCodes.ts';
import type { WikiRegistry } from '../../src/wikis/wikiRegistry.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.ts';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';

function fakeRegistry(wikis: Record<string, Partial<WikiConfig>>): WikiRegistry {
	return {
		getAll: () => wikis as Record<string, WikiConfig>,
		get: (k: string) => wikis[k] as WikiConfig | undefined,
		add: () => {},
		remove: () => {},
		isManagementAllowed: () => false,
	} as unknown as WikiRegistry;
}

// `issuer` stands in for a whole ProxyConfig: the protected-resource document is
// the only consumer here and it reads nothing else.
function buildWellKnownApp(registry: WikiRegistry, issuer?: string): Express {
	const app = express();
	app.use(express.json());
	app.get(
		'/.well-known/oauth-protected-resource',
		createOAuthProtectedResourceHandler({
			wikiRegistry: registry,
			getProxyConfig: () => (issuer === undefined ? null : ({ issuer } as never)),
		}),
	);
	return app;
}

const PROXY_ISSUER = 'https://mcp.example/mcp';

// Enough of a ProxyConfig for the route to report that a protected-resource
// document exists. The challenge only advertises resource_metadata when one does.
const WITH_PROXY = { getProxyConfig: () => ({ issuer: PROXY_ISSUER }) as never };

function buildMcpApp(
	registry?: WikiRegistry,
	options: Omit<McpRouteOptions, 'wikiRegistry'> = {},
): Express {
	const app = express();
	app.use(express.json());
	const handler = createMcpHandler(
		() => new McpServer({ name: 'oauth-test-server', version: '0.0.0' }, { capabilities: {} }),
		{ legacy: 'stateless' },
	);
	app.post('/mcp', createMcpRouteHandler(handler, { wikiRegistry: registry, ...options }));
	return app;
}

describe('GET /.well-known/oauth-protected-resource', () => {
	let fakeAs: FakeAsHandle | undefined;

	afterEach(async () => {
		_resetMetadataCacheForTesting();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	it('advertises the proxy issuer when the hosted proxy is enabled', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const registry = fakeRegistry({ mywiki: wikiCfg });
		const app = buildWellKnownApp(registry, PROXY_ISSUER);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(200);
		// This server is the authorization server, so it names itself. The wiki's own
		// issuer is deliberately never advertised: a client minting a token there and
		// presenting it here is the shape the passthrough prohibition forbids.
		expect(res.body.authorization_servers).toEqual([PROXY_ISSUER]);
		expect(res.body.authorization_servers).not.toContain(fakeAs.url);
		expect(res.body.bearer_methods_supported).toEqual(['header']);
	});

	it('returns 404 when no wiki has oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'PlainWiki',
			server: 'https://plain.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const registry = fakeRegistry({ plain: wikiCfg });
		const app = buildWellKnownApp(registry, PROXY_ISSUER);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(404);
	});

	it('returns 404 when oauth2ClientId is an empty string', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'EmptyOAuth',
			server: 'https://empty.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: '',
		};
		const registry = fakeRegistry({ empty: wikiCfg });
		const app = buildWellKnownApp(registry, PROXY_ISSUER);

		const res = await request(app).get('/.well-known/oauth-protected-resource');
		expect(res.status).toBe(404);
	});

	it('uses x-forwarded-proto for the resource URL', async () => {
		fakeAs = await startFakeAs();
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: fakeAs.url,
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'my-client-id',
		};
		const registry = fakeRegistry({ mywiki: wikiCfg });
		const app = buildWellKnownApp(registry, PROXY_ISSUER);

		// MCP_PUBLIC_URL not set; resource is derived from host header and proto
		const res = await request(app)
			.get('/.well-known/oauth-protected-resource')
			.set('Host', 'mcp.example.org')
			.set('x-forwarded-proto', 'https');
		expect(res.status).toBe(200);
		// resource should use https and be the slash-free canonical identifier
		expect(res.body.resource).toBe('https://mcp.example.org');
	});

	it('is not served at all when the proxy is disabled', async () => {
		fakeAs = await startFakeAs();
		const app = buildWellKnownApp(
			fakeRegistry({
				mywiki: {
					sitename: 'OAuthWiki',
					server: fakeAs.url,
					scriptpath: '/w',
					articlepath: '/wiki',
					oauth2ClientId: 'my-client-id',
				},
			}),
		);

		const res = await request(app).get('/.well-known/oauth-protected-resource');

		expect(res.status).toBe(404);
		expect(fakeAs.metadataRequests.count).toBe(0);
	});

	it('still serves the document when one wiki metadata fetch rejects', async () => {
		fakeAs = await startFakeAs();
		// A second AS that explicitly advertises a non-S256 PKCE method makes
		// fetchMetadata reject with MetadataError; Promise.allSettled keeps it
		// out of the document while the reachable wiki's AS survives.
		const badAs = await startFakeAs({
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		try {
			const reachable: Partial<WikiConfig> = {
				sitename: 'Reachable',
				server: fakeAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-ok',
			};
			const rejecting: Partial<WikiConfig> = {
				sitename: 'Rejecting',
				server: badAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-bad',
			};
			const registry = fakeRegistry({ reachable: reachable, rejecting: rejecting });
			const app = buildWellKnownApp(registry, PROXY_ISSUER);

			const res = await request(app).get('/.well-known/oauth-protected-resource');
			// Upstream metadata is still fetched, for scopes_supported, so one wiki
			// being unreachable must not take the whole document down. Neither wiki's
			// issuer appears in it — this server names only itself.
			expect(res.status).toBe(200);
			expect(res.body.authorization_servers).toEqual([PROXY_ISSUER]);
			expect(res.body.authorization_servers).not.toContain(badAs.url);
		} finally {
			await badAs.close();
		}
	});

	it('returns 503 when every OAuth wiki metadata fetch rejects', async () => {
		const badAs = await startFakeAs({
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		try {
			const rejecting: Partial<WikiConfig> = {
				sitename: 'Rejecting',
				server: badAs.url,
				scriptpath: '/w',
				articlepath: '/wiki',
				oauth2ClientId: 'client-bad',
			};
			const registry = fakeRegistry({ rejecting: rejecting });
			const app = buildWellKnownApp(registry, PROXY_ISSUER);

			const res = await request(app).get('/.well-known/oauth-protected-resource');
			expect(res.status).toBe(503);
			expect(res.body.error).toBe('discovery_failed');
		} finally {
			await badAs.close();
		}
	});
});

describe('POST /mcp 401 short-circuit when every wiki requires auth', () => {
	// The challenge tells a caller to supply a wiki token, which is only actionable
	// while forwarding one is available. Without the opt-in there is nothing a
	// client can do, so the challenge is not emitted at all.
	beforeEach(() => {
		vi.stubEnv('MCP_ALLOW_BEARER_PASSTHROUGH', 'true');
	});

	afterEach(() => {
		delete process.env.MCP_ALLOW_STATIC_FALLBACK;
		vi.unstubAllEnvs();
	});

	it('returns 401 with WWW-Authenticate when no bearer and wiki has oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }), WITH_PROXY);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		expect(res.body?.jsonrpc).toBe('2.0');
		expect(res.body?.error?.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/^Bearer /);
		expect(wwwAuth).toMatch(/error="invalid_token"/);
		expect(wwwAuth).toMatch(/realm="MediaWiki MCP Server"/);
		expect(wwwAuth).toMatch(/resource_metadata="/);
		expect(wwwAuth).toMatch(/\/.well-known\/oauth-protected-resource"/);
	});

	it('omits resource_metadata when no protected-resource document is served', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		// No proxy, so /.well-known/oauth-protected-resource answers 404. Advertising
		// it would send an RFC 9728 client to a document that does not exist.
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const challenge = res.headers['www-authenticate'] ?? '';
		expect(challenge).toContain('Bearer error="invalid_token"');
		expect(challenge).not.toContain('resource_metadata');
	});

	it('does NOT return 401 when the wiki has no oauth2ClientId', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'PlainWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const app = buildMcpApp(fakeRegistry({ plain: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when wikiRegistry is not provided to handler', async () => {
		// If wikiRegistry is omitted entirely, the 401 check is skipped
		const app = buildMcpApp(undefined);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when a bearer is present and forwarding is opted into', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer some-valid-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		// With a bearer token present, the 401 short-circuit is skipped;
		// the request proceeds to the MCP transport machinery.
		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when MCP_ALLOW_STATIC_FALLBACK=true and wiki has static creds + oauth2ClientId', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'FallbackWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-456',
			token: 'static-bot-token',
		};
		const app = buildMcpApp(fakeRegistry({ fallback: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('does NOT return 401 when MCP_ALLOW_STATIC_FALLBACK=true and wiki has username+password + oauth2ClientId', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'FallbackWiki2',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-789',
			username: 'bot-user',
			password: 'bot-pass',
		};
		const app = buildMcpApp(fakeRegistry({ fallback2: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('DOES return 401 when oauth2ClientId set and MCP_ALLOW_STATIC_FALLBACK=true but no static creds', async () => {
		process.env.MCP_ALLOW_STATIC_FALLBACK = 'true';
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthOnly',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-000',
		};
		const app = buildMcpApp(fakeRegistry({ oauthonly: wikiCfg }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
	});

	it('metadata URL in WWW-Authenticate uses x-forwarded-proto when present', async () => {
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }), WITH_PROXY);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Host', 'mcp.example.org:443')
			.set('x-forwarded-proto', 'https')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('https://mcp.example.org:443/.well-known/oauth-protected-resource');
	});

	it('resource_metadata is origin-rooted even when MCP_PUBLIC_URL carries a path (#2)', async () => {
		// Shape-3 deployment: MCP_PUBLIC_URL = the public /mcp URL. The PRM is served
		// only at the origin root, and the SDK fetches resource_metadata verbatim with
		// no fallback — so the 401 URL must NOT carry the /mcp path or it 404s.
		vi.stubEnv('MCP_PUBLIC_URL', 'https://wiki.example.org/mcp');
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }), WITH_PROXY);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain(
			'resource_metadata="https://wiki.example.org/.well-known/oauth-protected-resource"',
		);
		expect(wwwAuth).not.toContain('/mcp/.well-known');
	});

	it('metadata URL in WWW-Authenticate honours MCP_PUBLIC_URL over request Host', async () => {
		vi.stubEnv('MCP_PUBLIC_URL', 'https://override.example.org/');
		const wikiCfg: Partial<WikiConfig> = {
			sitename: 'OAuthWiki',
			server: 'https://wiki.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-id-123',
		};
		const app = buildMcpApp(fakeRegistry({ mywiki: wikiCfg }), WITH_PROXY);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Host', 'internal.example.org')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('https://override.example.org/.well-known/oauth-protected-resource');
		expect(wwwAuth).not.toContain('internal.example.org');
	});

	it('returns 401 when EVERY configured wiki is OAuth-only', async () => {
		const wikiA: Partial<WikiConfig> = {
			sitename: 'OAuthA',
			server: 'https://a.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-a',
		};
		const wikiB: Partial<WikiConfig> = {
			sitename: 'OAuthB',
			server: 'https://b.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-b',
		};
		const app = buildMcpApp(fakeRegistry({ wikiA: wikiA, wikiB: wikiB }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		expect(res.body?.error?.code).toBe(AUTHENTICATION_REQUIRED_ERROR_CODE);
		const wwwAuth = res.headers['www-authenticate'];
		expect(typeof wwwAuth).toBe('string');
		expect(wwwAuth).toMatch(/^Bearer /);
		expect(wwwAuth).toMatch(/error="invalid_token"/);
		expect(wwwAuth).toMatch(/realm="MediaWiki MCP Server"/);
	});

	it('does NOT return 401 when one wiki is OAuth-only but another needs no auth', async () => {
		const oauthWiki: Partial<WikiConfig> = {
			sitename: 'OAuthOnly',
			server: 'https://oauth.example',
			scriptpath: '/w',
			articlepath: '/wiki',
			oauth2ClientId: 'client-oauth',
		};
		const publicWiki: Partial<WikiConfig> = {
			sitename: 'PublicWiki',
			server: 'https://public.example',
			scriptpath: '/w',
			articlepath: '/wiki',
		};
		const app = buildMcpApp(fakeRegistry({ oauth: oauthWiki, public: publicWiki }));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});
});
