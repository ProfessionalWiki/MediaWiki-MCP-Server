import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

import request from 'supertest';
import type { RequestHandler } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	buildApp,
	resolveUpstreamBearer,
	type BuildAppDeps,
	type SessionRegistry,
} from '../../src/transport/streamableHttp.js';
import { createAppState } from '../../src/wikis/state.js';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.js';
import { CimdResolver } from '../../src/auth/authorizationServer/cimd.js';
import type { CimdFetchResult } from '../../src/transport/cimdFetch.js';
import { verifyAccessToken } from '../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
import {
	buildRedirectPolicy,
	parseRedirectAllowlist,
} from '../../src/auth/authorizationServer/redirectPolicy.js';
import { checkWikiCapability } from '../../src/runtime/wikiCapability.js';
import { createToolContext } from '../../src/runtime/createContext.js';
import { logger } from '../../src/runtime/logger.js';
import { withRequestContext, getRuntimeToken } from '../../src/transport/requestContext.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';
import { runHostedFlow } from '../helpers/fakeMcpClient.js';

const ISSUER = 'https://mcp.example/mcp';
const SIGNING_KEY = 'k'.repeat(32);

// Builds a fake AppState whose single OAuth wiki points at the live fake AS, so
// the protected-resource discovery and capability guard see a realistic wiki.
function appState(fakeAsUrl: string) {
	return createAppState({
		defaultWiki: 'test',
		wikis: {
			test: {
				sitename: 'Test Wiki',
				server: fakeAsUrl,
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'UPSTREAM-CLIENT',
				token: null,
				username: null,
				password: null,
			},
		},
		uploadDirs: [],
	});
}

// A ProxyConfig whose authorize + token-exchange bases both point at the fake AS
// (so the in-process flow reaches it), as the task guidance prescribes.
function proxyConfig(fakeAsUrl: string): ProxyConfig {
	return {
		issuer: ISSUER,
		authorizeBase: fakeAsUrl,
		tokenExchangeBase: fakeAsUrl,
		scriptpath: '/w',
		callbackUrl: `${ISSUER}/oauth/callback`,
		upstreamClientId: 'UPSTREAM-CLIENT',
		signingKey: SIGNING_KEY,
		consentTtlMs: 60_000,
		tokenTtlMs: 55 * 60 * 1000,
		redirectAllowlist: [],
		cimdAllowedHosts: [],
	};
}

// Stub MCP server; never actually connected because the /mcp tests pre-seed a
// fake transport into the returned sessions registry.
function stubCreateServer(): McpServer {
	return new McpServer({ name: 'proxy-e2e', version: '0.0.0' }, { capabilities: {} });
}

function makeDeps(
	fakeAsUrl: string,
	store: InMemoryProxyStore,
	pc: ProxyConfig | null,
): BuildAppDeps {
	return {
		state: appState(fakeAsUrl),
		getProxyConfig: () => pc,
		proxyStore: store,
		proxyRedirectPolicy: pc ? buildRedirectPolicy(pc.redirectAllowlist) : null,
		cimdResolver: null,
		defaultWikiKey: 'test',
		defaultWikiSitename: 'Test Wiki',
		createServerFn: stubCreateServer,
		host: '127.0.0.1',
		allowedHosts: undefined,
		allowedOrigins: undefined,
		maxRequestBody: '1mb',
		sessionIdleTimeoutMs: 0,
	};
}

describe('hosted OAuth proxy — end-to-end (real buildApp routes)', () => {
	let fakeAs: FakeAsHandle | undefined;

	// Pin MCP_PUBLIC_URL to the proxy issuer's base so the protected-resource
	// document's `resource` field (resolvePublicBase) resolves to the SAME host
	// as the proxy issuer — but WITH a trailing slash (`https://mcp.example/mcp/`)
	// while the issuer stays slash-free (`https://mcp.example/mcp`). The fake MCP
	// client now sources its `resource` indicator from that document, so the flow
	// exercises the /authorize trailing-slash normalization (Fix 1). Without it,
	// /authorize would reject the slash-bearing resource as a mismatch and the
	// flow would never reach the consent page.
	beforeEach(() => {
		vi.stubEnv('MCP_PUBLIC_URL', ISSUER);
	});

	afterEach(async () => {
		vi.unstubAllEnvs();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	it('criterion 1: full flow mints a proxy token whose aud is the issuer; the UPSTREAM token (not the proxy JWT) reaches the wiki API', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true, captureApi: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app, sessions } = buildApp(makeDeps(fakeAs.url, store, pc));

		const result = await runHostedFlow({ app });

		// A proxy access + refresh token were minted.
		expect(result.accessToken).toBeTruthy();
		expect(result.refreshToken).toBeTruthy();

		// The minted access token verifies and its audience is the issuer (self).
		const verified = await verifyAccessToken(result.accessToken, pc);
		expect(verified.upstreamTokenId).toBeTruthy();

		// The stored upstream token is the wiki access token the fake AS issued for
		// the auto-approved code (`access-auth-<state>`), reachable via resolve.
		const upstreamToken = await resolveUpstreamBearer(result.accessToken, pc, store);
		expect(upstreamToken).toMatch(/^access-auth-/);
		// The proxy JWT and the upstream wiki token are distinct values.
		expect(upstreamToken).not.toBe(result.accessToken);

		// Now drive a REAL /mcp POST: pre-seed a session whose transport, inside
		// withRequestContext, calls the wiki action API with the resolved runtime
		// token. This proves the UPSTREAM token — not the proxy JWT — is what mwn
		// would send to /api.php.
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
				const runtimeToken = getRuntimeToken();
				await fetch(`${fakeAs!.url}/w/api.php?action=query&meta=tokens`, {
					headers: runtimeToken ? { Authorization: `Bearer ${runtimeToken}` } : {},
				});
				res.status(200).json({ ok: true });
			},
		);
		const transport = {
			sessionId: 'sid-1',
			handleRequest,
		} as unknown as SessionRegistry[string]['transport'];
		sessions['sid-1'] = { transport, activeRequests: 0 };

		const mcpRes = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${result.accessToken}`)
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(mcpRes.status).not.toBe(401);
		expect(handleRequest).toHaveBeenCalledOnce();
		// The wiki API saw the UPSTREAM wiki token, never the proxy JWT.
		expect(fakeAs.capturedApiBearers).toContain(upstreamToken);
		expect(fakeAs.capturedApiBearers).not.toContain(result.accessToken);
	});

	it('criterion 2: the upstream/wiki token never appears in the /token or /register response bodies', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const result = await runHostedFlow({ app });

		// Resolve the upstream wiki token the proxy is holding for this grant.
		const upstreamToken = await resolveUpstreamBearer(result.accessToken, pc, store);
		expect(upstreamToken).toMatch(/^access-auth-/);

		const tokenJson = JSON.stringify(result.tokenBody);
		const registerJson = JSON.stringify(result.registerBody);

		// Neither the wiki access token nor its refresh token leaks downstream.
		expect(tokenJson).not.toContain(upstreamToken);
		expect(tokenJson).not.toContain('access-auth-');
		expect(tokenJson).not.toContain('refresh-auth-');
		expect(registerJson).not.toContain(upstreamToken);
		expect(registerJson).not.toContain('access-auth-');
	});

	it('criterion 3: anonymous read works with no token; a write tool with no token returns the auth-required step-up', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const deps = makeDeps(fakeAs.url, store, pc);
		const { app, sessions } = buildApp(deps);

		// (a) A tokenless /mcp POST is served anonymously (no 401 short-circuit).
		const captured: { token?: string; seen: boolean } = { seen: false };
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
				captured.seen = true;
				captured.token = getRuntimeToken();
				res.status(200).json({ ok: true });
			},
		);
		sessions['sid-anon'] = {
			transport: {
				sessionId: 'sid-anon',
				handleRequest,
			} as unknown as SessionRegistry[string]['transport'],
			activeRequests: 0,
		};
		const anonRes = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-anon')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(anonRes.status).not.toBe(401);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBeUndefined();

		// (b) The wikiCapability step-up: with no runtime token, a write tool is
		// rejected with an authentication error, while a read tool is allowed.
		const ctx = createToolContext({
			logger,
			state: deps.state,
			transport: 'http',
			getProxyConfig: deps.getProxyConfig,
		});

		const writeResult = await withRequestContext(undefined, undefined, () =>
			checkWikiCapability('update-page', 'test', ctx),
		);
		expect(writeResult).toBeDefined();
		expect(writeResult?.isError).toBe(true);
		const writeText = JSON.stringify(writeResult?.content);
		expect(writeText).toMatch(/[Aa]uthentication required/);
		expect(writeText).toContain('/.well-known/oauth-protected-resource');

		// A read-only tool (e.g. get-page) is NOT a write tool, so it passes the
		// capability guard anonymously (returns undefined = proceed).
		const readResult = await withRequestContext(undefined, undefined, () =>
			checkWikiCapability('get-page', 'test', ctx),
		);
		expect(readResult).toBeUndefined();
	});

	it('criterion 4: confused deputy — a code cannot be redeemed with a foreign PKCE verifier, and a consent cookie bound to one client is rejected at the callback for another client', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		// Client B completes a flow up to (but not redeeming) its downstream code.
		// The code is bound to B's own PKCE challenge.
		const flowB = await runFlowUpToCode(app, '127.0.0.1');

		// A confused deputy (a different client, or B fumbling its own state)
		// attempts to redeem B's authorization code with a DIFFERENT PKCE verifier
		// than the challenge the code was bound to. PKCE binds the code to the
		// verifier, so this must be rejected with invalid_grant.
		const tokenRes = await request(app).post('/mcp/token').type('form').send({
			grant_type: 'authorization_code',
			code: flowB.clientCode,
			code_verifier: 'a-totally-different-verifier-not-matching-the-challenge',
			client_id: flowB.clientId,
			redirect_uri: flowB.redirectUri,
		});
		expect(tokenRes.status).toBe(400);
		expect(tokenRes.body.error).toBe('invalid_grant');

		// And: a consent cookie bound to client A is rejected at the callback for a
		// transaction belonging to client B (cookie/clientId mismatch).
		const mismatch = await callbackWithMismatchedConsent(app, store, pc);
		expect(mismatch.status).toBe(400);
		expect(mismatch.headers['content-type']).toMatch(/html/);
		expect(mismatch.text).toMatch(/consent not present/);
	});

	it('criterion 5: open-redirect — /register with a non-allowlisted redirect_uri returns 400', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const res = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({
				redirect_uris: ['https://attacker.example/steal'],
				client_name: 'Evil client',
			});
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');

		// A loopback redirect is accepted (proves the 400 above is the policy, not
		// a blanket failure).
		const ok = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ redirect_uris: ['http://127.0.0.1:9999/cb'], client_name: 'Good client' });
		expect(ok.status).toBe(201);
	});
	it('criterion 5: a consent approval is rejected without a matching CSRF token', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const redirectUri = 'http://127.0.0.1:47100/cb';
		const reg = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ redirect_uris: [redirectUri], client_name: 'CSRF' });
		const { randomVerifier, s256 } = await import('../../src/auth/pkce.js');
		const params = {
			client_id: String(reg.body.client_id),
			redirect_uri: redirectUri,
			state: 'state-csrf',
			code_challenge: s256(randomVerifier()),
			code_challenge_method: 'S256',
			scope: 'mwoauth-authonly',
		};
		const authz = await request(app).get('/mcp/authorize').query(params);
		expect(authz.status).toBe(200);
		const csrfSetCookie = ((authz.headers['set-cookie'] as string[] | undefined) ?? []).find((c) =>
			c.startsWith('mcp_consent_csrf='),
		);
		const csrf = csrfSetCookie ? csrfSetCookie.split(';')[0].split('=').slice(1).join('=') : '';
		expect(csrf).toBeTruthy();

		// No cookie and no field → rejected.
		const noCsrf = await request(app)
			.post('/mcp/consent')
			.query(params)
			.type('form')
			.send({ decision: 'approve' });
		expect(noCsrf.status).toBe(400);
		expect(noCsrf.headers['content-type']).toMatch(/html/);
		expect(noCsrf.text).toMatch(/Authorization failed/);
		expect(noCsrf.text).toMatch(/CSRF/i);

		// Field present but no matching cookie (a cross-site POST can't carry the
		// SameSite=Strict cookie) → rejected.
		const noCookie = await request(app)
			.post('/mcp/consent')
			.query(params)
			.type('form')
			.send({ decision: 'approve', csrf });
		expect(noCookie.status).toBe(400);
		expect(noCookie.headers['content-type']).toMatch(/html/);
		expect(noCookie.text).toMatch(/CSRF/i);

		// Cookie + matching field → accepted (302 to the upstream authorize URL).
		const ok = await request(app)
			.post('/mcp/consent')
			.query(params)
			.set('Cookie', `mcp_consent_csrf=${csrf}`)
			.type('form')
			.send({ decision: 'approve', csrf });
		expect(ok.status).toBe(302);
	});
	it('criterion 6: a grant-screen denial (no state, MediaWiki unauthorized_client) is bounced to the client as access_denied via the txn cookie', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const cookieValue = (res: { headers: Record<string, unknown> }, name: string): string => {
			const set = (res.headers['set-cookie'] as string[] | undefined) ?? [];
			const c = set.find((x) => x.startsWith(`${name}=`));
			return c ? c.split(';')[0].split('=').slice(1).join('=') : '';
		};

		const redirectUri = 'http://127.0.0.1:47100/cb';
		const reg = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ redirect_uris: [redirectUri], client_name: 'D' });
		const { randomVerifier, s256 } = await import('../../src/auth/pkce.js');
		const params = {
			client_id: String(reg.body.client_id),
			redirect_uri: redirectUri,
			state: 'client-state-9',
			code_challenge: s256(randomVerifier()),
			code_challenge_method: 'S256',
			scope: 'mwoauth-authonly',
		};

		const authz = await request(app).get('/mcp/authorize').query(params);
		const csrf = cookieValue(authz, 'mcp_consent_csrf');
		const consent = await request(app)
			.post('/mcp/consent')
			.query(params)
			.set('Cookie', `mcp_consent_csrf=${csrf}`)
			.type('form')
			.send({ decision: 'approve', csrf });
		expect(consent.status).toBe(302);
		const txnCookie = cookieValue(consent, 'mcp_txn');
		expect(txnCookie).toBeTruthy();

		// Simulate MediaWiki's denial: it redirects to the callback with
		// `unauthorized_client`, NO state and NO code — but the browser still carries
		// the mcp_txn cookie set when we redirected to the wiki.
		const cb = await request(app)
			.get('/mcp/oauth/callback')
			.query({ error: 'unauthorized_client', error_description: 'user denied' })
			.set('Cookie', `mcp_txn=${txnCookie}`);
		expect(cb.status).toBe(302);
		const loc = new URL(cb.headers.location as string);
		expect(loc.origin + loc.pathname).toBe(redirectUri);
		expect(loc.searchParams.get('error')).toBe('access_denied');
		expect(loc.searchParams.get('state')).toBe('client-state-9');
	});
	it('criterion 7: the txn cookie is NOT consulted for a success/code callback (denials only)', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		// Seed a transaction the cookie points at; if the cookie were (wrongly) honoured
		// on the code path, handleCallback would resolve it and attempt the exchange.
		store.putTransaction('txn-x', {
			clientId: 'c',
			clientRedirectUri: 'http://127.0.0.1:1/cb',
			clientState: 's',
			clientCodeChallenge: 'x',
			clientCodeChallengeMethod: 'S256',
			scopes: [],
			proxyVerifier: 'v',
		});

		// code present, NO state, NO error, txn cookie present → cookie must be ignored,
		// so state stays undefined and the callback reports missing code/state.
		const cb = await request(app)
			.get('/mcp/oauth/callback')
			.query({ code: 'somecode' })
			.set('Cookie', 'mcp_txn=txn-x');
		expect(cb.status).toBe(400);
		expect(cb.headers['content-type']).toMatch(/html/);
		expect(cb.text).toMatch(/missing code\/state/i);
		// The seeded transaction was not consumed.
		expect(store.getTransaction('txn-x')).toBeDefined();
	});

	it('the 401 challenge advertises error="invalid_token"', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('Authorization', 'Bearer not-a-valid-proxy-jwt')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).toBe(401);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- supertest header value is string|string[]
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('error="invalid_token"');
		expect(wwwAuth).toContain('resource_metadata=');
	});

	it('CIMD: a URL client_id on an allowlisted host resolves via its metadata document and reaches consent; an off-allowlist host is rejected', async () => {
		const store = new InMemoryProxyStore();
		const pc = proxyConfig('https://test.example');

		// A URL client_id whose host is on the resolver's allowlist. The stub fetcher
		// returns a self-referential document (client_id === the fetched URL) whose
		// redirect_uris list the redirect the authorize request will send. NO network:
		// the fetcher is a closure over the test's redirectUri.
		const clientId = 'https://vscode.dev/oauth/client-metadata.json';
		const redirectUri = 'https://vscode.dev/redirect';
		let fetchCalls = 0;
		const countingFetcher = async (url: string): Promise<CimdFetchResult> => {
			fetchCalls++;
			return {
				status: 200,
				body: JSON.stringify({
					client_id: url,
					client_name: 'VS Code',
					redirect_uris: [redirectUri],
				}),
				cacheControl: null,
			};
		};
		const cimdResolver = new CimdResolver((h) => h === 'vscode.dev', countingFetcher);

		const { app } = buildApp({ ...makeDeps('https://test.example', store, pc), cimdResolver });

		// Success: allowlisted host → document fetched, self-matches → consent page,
		// which names the VERIFIED client_id host (vscode.dev), not just client_name.
		const ok = await request(app).get('/mcp/authorize').query({
			response_type: 'code',
			client_id: clientId,
			code_challenge: 'abc123',
			code_challenge_method: 'S256',
			redirect_uri: redirectUri,
			state: 's',
			resource: ISSUER,
		});
		expect(ok.status).toBe(200);
		expect(ok.text).toContain('vscode.dev');
		// Uniquely proves the verified-host line rendered: 'vscode.dev' alone also
		// appears on the redirectHost line, so assert the verified-line literal too.
		expect(ok.text).toContain('Verified application');

		// The allowed-host success above consulted the fetcher once; reset so the
		// count below reflects ONLY the off-allowlist request.
		fetchCalls = 0;

		// Rejection: the host is NOT on the allowlist, so the gate fails BEFORE the
		// fetcher is ever consulted → the 400 auth-error page.
		const rejected = await request(app).get('/mcp/authorize').query({
			response_type: 'code',
			client_id: 'https://evil.example/c.json',
			code_challenge: 'abc123',
			code_challenge_method: 'S256',
			redirect_uri: redirectUri,
			state: 's',
			resource: ISSUER,
		});
		expect(rejected.status).toBe(400);
		expect(rejected.headers['content-type']).toMatch(/html/);
		expect(rejected.text).toMatch(/Authorization failed/);
		// The host allowlist gate ran before any fetch, and the CIMD rejection reason
		// (not just a generic error title) is rendered on the page.
		expect(fetchCalls).toBe(0);
		expect(rejected.text).toMatch(/not a trusted CIMD host|evil\.example/);
	});

	it('CIMD: rejects a document that lists a cleartext http non-loopback redirect', async () => {
		const store = new InMemoryProxyStore();
		const pc = proxyConfig('https://test.example');
		const clientId = 'https://vscode.dev/oauth/client-metadata.json';
		const badRedirect = 'http://evil.example/cb';
		// Allowlisted host, but the fetched document declares a cleartext http redirect to
		// a non-loopback host — validateCimdDocument rejects it, so resolve fails and
		// /authorize renders the 400 auth-error page. No code is ever minted.
		const fetcher = async (url: string): Promise<CimdFetchResult> => ({
			status: 200,
			body: JSON.stringify({
				client_id: url,
				client_name: 'VS Code',
				redirect_uris: [badRedirect],
			}),
			cacheControl: null,
		});
		const cimdResolver = new CimdResolver((h) => h === 'vscode.dev', fetcher);
		const { app } = buildApp({ ...makeDeps('https://test.example', store, pc), cimdResolver });

		const res = await request(app).get('/mcp/authorize').query({
			response_type: 'code',
			client_id: clientId,
			code_challenge: 'abc123',
			code_challenge_method: 'S256',
			redirect_uri: badRedirect,
			state: 's',
			resource: ISSUER,
		});
		expect(res.status).toBe(400);
		expect(res.headers['content-type']).toMatch(/html/);
		expect(res.text).toMatch(/Authorization failed/);
	});
});

describe('private wiki — connection-time auth challenge', () => {
	let fakeAs: FakeAsHandle | undefined;

	beforeEach(() => {
		vi.stubEnv('MCP_PUBLIC_URL', ISSUER);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	function privateDeps(
		fakeAsUrl: string,
		store: InMemoryProxyStore,
		pc: ProxyConfig | null,
	): BuildAppDeps {
		const state = createAppState({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test Wiki',
					server: fakeAsUrl,
					articlepath: '/wiki',
					scriptpath: '/w',
					oauth2ClientId: 'UPSTREAM-CLIENT',
					private: true,
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		});
		return {
			state,
			getProxyConfig: () => pc,
			proxyStore: store,
			proxyRedirectPolicy: pc ? buildRedirectPolicy(pc.redirectAllowlist) : null,
			cimdResolver: null,
			defaultWikiKey: 'test',
			defaultWikiSitename: 'Test Wiki',
			createServerFn: stubCreateServer,
			host: '127.0.0.1',
			allowedHosts: undefined,
			allowedOrigins: undefined,
			maxRequestBody: '1mb',
			sessionIdleTimeoutMs: 0,
		};
	}

	it('challenges an anonymous initialize with 401 + WWW-Authenticate', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(privateDeps(fakeAs.url, store, pc));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({
				jsonrpc: '2.0',
				id: 1,
				method: 'initialize',
				params: {
					protocolVersion: '2025-06-18',
					capabilities: {},
					clientInfo: { name: 'test', version: '0' },
				},
			});

		expect(res.status).toBe(401);
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- supertest header value is string|string[]
		const wwwAuth = res.headers['www-authenticate'] as string;
		expect(wwwAuth).toContain('error="invalid_token"');
		expect(wwwAuth).toContain('resource_metadata=');
	});

	it('challenges an anonymous GET (SSE) with 401', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(privateDeps(fakeAs.url, store, pc));

		const res = await request(app).get('/mcp').set('mcp-session-id', 'irrelevant');

		expect(res.status).toBe(401);
	});

	it('does NOT challenge an anonymous request when the wiki is public', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });

		expect(res.status).not.toBe(401);
	});

	it('warns when a private wiki has no oauth2ClientId', () => {
		const warnSpy = vi.spyOn(logger, 'warning');
		const state = createAppState({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test Wiki',
					server: 'https://wiki.example',
					articlepath: '/wiki',
					scriptpath: '/w',
					private: true,
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		});
		buildApp({
			state,
			getProxyConfig: () => null,
			proxyStore: new InMemoryProxyStore(),
			proxyRedirectPolicy: null,
			cimdResolver: null,
			defaultWikiKey: 'test',
			defaultWikiSitename: 'Test Wiki',
			createServerFn: stubCreateServer,
			host: '127.0.0.1',
			allowedHosts: undefined,
			allowedOrigins: undefined,
			maxRequestBody: '1mb',
			sessionIdleTimeoutMs: 0,
		});

		expect(warnSpy).toHaveBeenCalledWith(
			expect.stringContaining('marked private but has no oauth2ClientId'),
		);
		warnSpy.mockRestore();
	});

	it('does not warn when a private wiki has an oauth2ClientId', () => {
		const warnSpy = vi.spyOn(logger, 'warning');
		const state = createAppState({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test Wiki',
					server: 'https://wiki.example',
					articlepath: '/wiki',
					scriptpath: '/w',
					oauth2ClientId: 'UPSTREAM-CLIENT',
					private: true,
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		});
		buildApp({
			state,
			getProxyConfig: () => null,
			proxyStore: new InMemoryProxyStore(),
			proxyRedirectPolicy: null,
			cimdResolver: null,
			defaultWikiKey: 'test',
			defaultWikiSitename: 'Test Wiki',
			createServerFn: stubCreateServer,
			host: '127.0.0.1',
			allowedHosts: undefined,
			allowedOrigins: undefined,
			maxRequestBody: '1mb',
			sessionIdleTimeoutMs: 0,
		});

		expect(warnSpy).not.toHaveBeenCalledWith(
			expect.stringContaining('marked private but has no oauth2ClientId'),
		);
		warnSpy.mockRestore();
	});
});

// Exercises the config -> ProxyConfig.redirectAllowlist -> buildApp -> route ->
// handleRegister seam with a REAL operator allowlist (not the empty default the
// rest of the suite uses). makeDeps derives proxyRedirectPolicy from
// pc.redirectAllowlist via the SAME buildRedirectPolicy call the production boot
// uses, so a regression to that wiring would 400 every allowlisted client here.
describe('operator redirect allowlist — end-to-end (config → route → handleRegister)', () => {
	beforeEach(() => {
		vi.stubEnv('MCP_PUBLIC_URL', ISSUER);
	});
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	// A ProxyConfig carrying a real operator entry: ChatGPT's per-connector prefix
	// pattern. The allowlist is the SAME value makeDeps feeds buildRedirectPolicy,
	// so the route's predicate is the operator policy, not the empty default.
	function allowlistProxyConfig(): ProxyConfig {
		return {
			...proxyConfig('https://wiki.example'),
			redirectAllowlist: parseRedirectAllowlist('https://chatgpt.com/connector/oauth/*'),
		};
	}

	function allowlistApp(): ReturnType<typeof buildApp>['app'] {
		const store = new InMemoryProxyStore();
		const pc = allowlistProxyConfig();
		return buildApp(makeDeps('https://wiki.example', store, pc)).app;
	}

	it('registers an allowlisted ChatGPT client (201)', async () => {
		const app = allowlistApp();
		const res = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({
				client_name: 'ChatGPT',
				redirect_uris: ['https://chatgpt.com/connector/oauth/abc123'],
			});
		expect(res.status).toBe(201);
	});

	it('rejects a non-allowlisted redirect (400 invalid_redirect_uri)', async () => {
		const app = allowlistApp();
		const res = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ client_name: 'x', redirect_uris: ['https://evil.example/cb'] });
		expect(res.status).toBe(400);
		expect(res.body.error).toBe('invalid_redirect_uri');
	});

	it('consent page names the remote destination host for an allowlisted client', async () => {
		const app = allowlistApp();
		const redirectUri = 'https://chatgpt.com/connector/oauth/abc123';
		const reg = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ client_name: 'ChatGPT', redirect_uris: [redirectUri] });
		expect(reg.status).toBe(201);
		const clientId = String(reg.body.client_id);

		// resource echoes the proxy issuer (pc.issuer === ISSUER); planAuthorize
		// compares it with trailing slashes normalized, so the slash-free issuer
		// value passes.
		const authz = await request(app).get('/mcp/authorize').query({
			response_type: 'code',
			client_id: clientId,
			code_challenge: 'abc123',
			code_challenge_method: 'S256',
			redirect_uri: redirectUri,
			state: 's',
			resource: ISSUER,
		});
		expect(authz.status).toBe(200);
		expect(authz.text).toContain('chatgpt.com');
	});

	it('consent page names an on-device application for a loopback client', async () => {
		const app = allowlistApp();
		const redirectUri = 'http://127.0.0.1:5599/cb';
		const reg = await request(app)
			.post('/mcp/register')
			.set('Content-Type', 'application/json')
			.send({ client_name: 'Local', redirect_uris: [redirectUri] });
		expect(reg.status).toBe(201);
		const clientId = String(reg.body.client_id);

		const authz = await request(app).get('/mcp/authorize').query({
			response_type: 'code',
			client_id: clientId,
			code_challenge: 'abc123',
			code_challenge_method: 'S256',
			redirect_uri: redirectUri,
			state: 's',
			resource: ISSUER,
		});
		expect(authz.status).toBe(200);
		expect(authz.text).toContain('an application on this device');
	});
});

// Exercises the REAL proactive-refresh path on the /mcp connection: buildApp uses
// the production refresh (defaultRefresh) against a live fake AS, so the full
// oauthFlow.refreshTokens -> classifyRefreshError -> UpstreamBearerError chain runs
// over HTTP — not through an injected refresh stub.
describe('hosted OAuth proxy — upstream refresh on the /mcp path (e2e)', () => {
	let fakeAs: FakeAsHandle | undefined;

	beforeEach(() => {
		vi.stubEnv('MCP_PUBLIC_URL', ISSUER);
	});
	afterEach(async () => {
		vi.unstubAllEnvs();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	// Mints normally on the auth-code grant but fails the refresh grant with a
	// transient 503, standing in for a momentary wiki outage during the proactive
	// refresh.
	const refreshBlipsToken: RequestHandler = (req, res) => {
		const grant = String(req.body.grant_type ?? '');
		if (grant === 'authorization_code') {
			res.json({
				access_token: 'access-' + String(req.body.code),
				refresh_token: 'refresh-' + String(req.body.code),
				expires_in: 3600,
				scope: 'edit',
				token_type: 'Bearer',
			});
			return;
		}
		if (grant === 'refresh_token') {
			res.status(503).end();
			return;
		}
		res.status(400).json({ error: 'unsupported_grant_type' });
	};

	// Overrides the stored upstream token's expiry (leaving its tokens intact) so a
	// subsequent /mcp call takes the proactive-refresh branch. Returns the stored
	// upstream access token so a test can assert which token reaches the wiki API.
	async function setUpstreamExpiry(
		store: InMemoryProxyStore,
		pc: ProxyConfig,
		proxyAccessToken: string,
		expiresAt: number,
	): Promise<string> {
		const { upstreamTokenId } = await verifyAccessToken(proxyAccessToken, pc);
		const u = store.getUpstreamToken(upstreamTokenId);
		if (!u) {
			throw new Error('expected an upstream token in the store');
		}
		store.updateUpstreamToken(upstreamTokenId, {
			accessToken: u.accessToken,
			refreshToken: u.refreshToken,
			expiresAt,
		});
		return u.accessToken;
	}

	// Pre-seeds a session whose fake transport calls the wiki action API with the
	// runtime token resolved for the request, so a test can observe which bearer
	// mwn would send upstream.
	function seedApiCallingSession(
		app: ReturnType<typeof buildApp>['app'],
		sessions: SessionRegistry,
	) {
		const handleRequest = vi.fn(
			async (_req: unknown, res: { status: (n: number) => { json: (b: unknown) => void } }) => {
				const runtimeToken = getRuntimeToken();
				await fetch(`${fakeAs!.url}/w/api.php?action=query&meta=tokens`, {
					headers: runtimeToken ? { Authorization: `Bearer ${runtimeToken}` } : {},
				});
				res.status(200).json({ ok: true });
			},
		);
		sessions['sid-1'] = {
			transport: {
				sessionId: 'sid-1',
				handleRequest,
			} as unknown as SessionRegistry[string]['transport'],
			activeRequests: 0,
		};
		return handleRequest;
	}

	const MCP_BODY = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

	it('answers 503 (retryable, no re-auth challenge) when an expired token cannot be refreshed', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true, token: refreshBlipsToken });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app } = buildApp(makeDeps(fakeAs.url, store, pc));
		const result = await runHostedFlow({ app });
		await setUpstreamExpiry(store, pc, result.accessToken, Date.now() - 1000);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${result.accessToken}`)
			.send(MCP_BODY);

		expect(res.status).toBe(503);
		// A retryable failure must NOT tell the client to re-authenticate.
		expect(res.headers['www-authenticate']).toBeUndefined();
	});

	it('serves the request with the still-valid upstream token when a proactive refresh blips', async () => {
		fakeAs = await startFakeAs({
			autoApproveAuthorize: true,
			captureApi: true,
			token: refreshBlipsToken,
		});
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app, sessions } = buildApp(makeDeps(fakeAs.url, store, pc));
		const result = await runHostedFlow({ app });
		// Inside the 30s skew but still valid: the refresh runs and blips, and the
		// current token is still usable.
		const upstreamAccess = await setUpstreamExpiry(
			store,
			pc,
			result.accessToken,
			Date.now() + 10_000,
		);
		const handleRequest = seedApiCallingSession(app, sessions);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${result.accessToken}`)
			.send(MCP_BODY);

		expect(res.status).not.toBe(401);
		expect(res.status).not.toBe(503);
		expect(handleRequest).toHaveBeenCalledOnce();
		// The wiki API saw the still-valid upstream token, not a re-auth.
		expect(fakeAs.capturedApiBearers).toContain(upstreamAccess);
	});

	it('refreshes the upstream token server-to-server and the NEW token reaches the wiki API', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true, captureApi: true });
		const store = new InMemoryProxyStore();
		const pc = proxyConfig(fakeAs.url);
		const { app, sessions } = buildApp(makeDeps(fakeAs.url, store, pc));
		const result = await runHostedFlow({ app });
		await setUpstreamExpiry(store, pc, result.accessToken, Date.now() + 10_000);
		const handleRequest = seedApiCallingSession(app, sessions);

		const res = await request(app)
			.post('/mcp')
			.set('Content-Type', 'application/json')
			.set('mcp-session-id', 'sid-1')
			.set('Authorization', `Bearer ${result.accessToken}`)
			.send(MCP_BODY);

		expect(res.status).not.toBe(401);
		expect(handleRequest).toHaveBeenCalledOnce();
		// The default fake AS rotates on refresh, so the wiki API sees the refreshed
		// token and the store now holds the rotated pair.
		expect(fakeAs.capturedApiBearers).toContain('access-refreshed');
		const { upstreamTokenId } = await verifyAccessToken(result.accessToken, pc);
		expect(store.getUpstreamToken(upstreamTokenId)?.accessToken).toBe('access-refreshed');
		expect(store.getUpstreamToken(upstreamTokenId)?.refreshToken).toBe('refresh-rotated');
	});
});

// Drives register -> authorize -> consent -> upstream -> callback and returns the
// minted (un-redeemed) downstream code, so a test can attempt redemption itself.
async function runFlowUpToCode(
	app: ReturnType<typeof buildApp>['app'],
	host: string,
): Promise<{ clientId: string; clientCode: string; redirectUri: string }> {
	const redirectUri = `http://${host}:47100/cb`;
	const reg = await request(app)
		.post('/mcp/register')
		.set('Content-Type', 'application/json')
		.send({ redirect_uris: [redirectUri], client_name: 'B' });
	const clientId = String(reg.body.client_id);

	// Use a fixed, valid PKCE pair the test controls; the verifier matching the
	// challenge is what client B would submit — we deliberately submit a DIFFERENT
	// one at redemption time.
	const { randomVerifier, s256 } = await import('../../src/auth/pkce.js');
	const verifier = randomVerifier();
	const params = {
		client_id: clientId,
		redirect_uri: redirectUri,
		state: 'state-B',
		code_challenge: s256(verifier),
		code_challenge_method: 'S256',
		scope: 'mwoauth-authonly',
	};
	const authz = await request(app).get('/mcp/authorize').query(params);
	const csrfSetCookie = ((authz.headers['set-cookie'] as string[] | undefined) ?? []).find((c) =>
		c.startsWith('mcp_consent_csrf='),
	);
	const csrf = csrfSetCookie ? csrfSetCookie.split(';')[0].split('=').slice(1).join('=') : '';
	const consent = await request(app)
		.post('/mcp/consent')
		.query(params)
		.set('Cookie', `mcp_consent_csrf=${csrf}`)
		.type('form')
		.send({ decision: 'approve', csrf });
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- supertest header value is string|string[]
	const cookie = (consent.headers['set-cookie'] as string[])[0].split(';')[0];
	const upstream = await fetch(consent.headers.location, { redirect: 'manual' });
	const cb = new URL(upstream.headers.get('location')!);
	const cbRes = await request(app)
		.get('/mcp/oauth/callback')
		.query({ code: cb.searchParams.get('code'), state: cb.searchParams.get('state') })
		.set('Cookie', cookie);
	const clientCode = new URL(cbRes.headers.location).searchParams.get('code')!;
	return { clientId, clientCode, redirectUri };
}

// Builds a transaction for client B but presents a consent cookie for client A,
// exercising the callback's cookie/clientId binding check.
async function callbackWithMismatchedConsent(
	app: ReturnType<typeof buildApp>['app'],
	store: InMemoryProxyStore,
	pc: ProxyConfig,
): Promise<{
	status: number;
	body: { error_description?: string };
	text: string;
	headers: Record<string, string>;
}> {
	const { buildConsentCookie } = await import('../../src/auth/authorizationServer/consent.js');
	// A transaction owned by client "B-real".
	store.putTransaction('txn-mismatch', {
		clientId: 'B-real',
		clientRedirectUri: 'http://127.0.0.1:47100/cb',
		clientState: 's',
		clientCodeChallenge: 'chal',
		clientCodeChallengeMethod: 'S256',
		scopes: [],
		proxyVerifier: 'pv',
	});
	// A consent cookie bound to a DIFFERENT client (A-evil) for the same host.
	const cookie = await buildConsentCookie(pc, {
		clientId: 'A-evil',
		redirectHost: '127.0.0.1',
		wiki: 'test',
	});
	const res = await request(app)
		.get('/mcp/oauth/callback')
		.query({ code: 'auth-txn-mismatch', state: 'txn-mismatch' })
		.set('Cookie', cookie.split(';')[0]);
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- response body is untyped JSON
	return {
		status: res.status,
		body: res.body as { error_description?: string },
		text: res.text,
		headers: res.headers as Record<string, string>,
	};
}
