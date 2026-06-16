import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';

// Importing streamableHttp.ts runs its module top-level boot (config load,
// startup guard, app.listen). Mock the config + mwn provider so that boot is
// harmless under test, matching the sibling streamableHttp.*.test.ts files. This
// e2e test does NOT use the module-level booted `app`; it calls the exported
// buildApp() factory directly with a fake-AS-backed proxy config, so the boot's
// proxy stays disabled (the mock config has no oauth2ClientId).
vi.mock('../../src/config/loadConfig.js', async (importOriginal) => {
	const actual = await importOriginal<typeof import('../../src/config/loadConfig.js')>();
	return {
		...actual,
		loadConfigFromFile: () => ({
			defaultWiki: 'test',
			wikis: {
				test: {
					sitename: 'Test',
					server: 'https://test.example',
					articlepath: '/wiki',
					scriptpath: '/w',
					token: null,
					username: null,
					password: null,
				},
			},
			uploadDirs: [],
		}),
	};
});

vi.mock('../../src/wikis/mwnProvider.js', () => ({
	MwnProviderImpl: class {
		get = () => Promise.reject(new Error('mwn not available in tests'));
		invalidate = () => {};
	},
}));

import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	buildApp,
	resolveUpstreamBearer,
	type BuildAppDeps,
	type SessionRegistry,
} from '../../src/transport/streamableHttp.js';
import { createAppState } from '../../src/wikis/state.js';
import { InMemoryProxyStore } from '../../src/auth/authorizationServer/proxyStore.js';
import { verifyAccessToken } from '../../src/auth/authorizationServer/jwt.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
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
		expect(mismatch.body.error_description).toMatch(/consent not present/);
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
	await request(app).get('/mcp/authorize').query(params);
	const consent = await request(app)
		.post('/mcp/consent')
		.query(params)
		.type('form')
		.send({ decision: 'approve' });
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
): Promise<{ status: number; body: { error_description?: string } }> {
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
	return { status: res.status, body: res.body as { error_description?: string } };
}
