// tests/transport/streamableHttp.proxyPersistence.smoke.test.ts
// SMOKE (#451): proxy sign-in state survives a simulated restart, exercised
// through the REAL buildApp routes + a real encrypted on-disk store.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import request from 'supertest';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	buildApp,
	resolveUpstreamBearer,
	type BuildAppDeps,
} from '../../src/transport/streamableHttp.js';
import { createAppState } from '../../src/wikis/state.js';
import {
	InMemoryProxyStore,
	type ProxyStore,
} from '../../src/auth/authorizationServer/proxyStore.js';
import { PersistentProxyStore } from '../../src/auth/authorizationServer/proxyStorePersistence.js';
import { deriveKey } from '../../src/auth/authorizationServer/proxyStoreCrypto.js';
import { buildRedirectPolicy } from '../../src/auth/authorizationServer/redirectPolicy.js';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.js';
import { randomVerifier, s256 } from '../../src/auth/pkce.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';
import { runHostedFlow } from '../helpers/fakeMcpClient.js';

const ISSUER = 'https://mcp.example/mcp';
const SIGNING_KEY = 'k'.repeat(32);

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

function makeDeps(fakeAsUrl: string, store: ProxyStore, pc: ProxyConfig): BuildAppDeps {
	return {
		state: appState(fakeAsUrl),
		getProxyConfig: () => pc,
		proxyStore: store,
		proxyRedirectPolicy: buildRedirectPolicy(pc.redirectAllowlist),
		cimdResolver: null,
		defaultWikiKey: 'test',
		defaultWikiSitename: 'Test Wiki',
		createServerFn: () => new McpServer({ name: 'smoke', version: '0.0.0' }, { capabilities: {} }),
		host: '127.0.0.1',
		allowedHosts: undefined,
		allowedOrigins: undefined,
		maxRequestBody: '1mb',
		sessionIdleTimeoutMs: 0,
	};
}

describe('#451 smoke: proxy sign-in survives a restart (real routes + encrypted file)', () => {
	let fakeAs: FakeAsHandle | undefined;
	beforeEach(() => vi.stubEnv('MCP_PUBLIC_URL', ISSUER));
	afterEach(async () => {
		vi.unstubAllEnvs();
		await fakeAs?.close();
		fakeAs = undefined;
	});

	it('rehydrates the upstream token, client, and refresh chain after a restart', async () => {
		fakeAs = await startFakeAs({ autoApproveAuthorize: true });
		const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-smoke-'));
		const file = path.join(dir, 'proxy-store.enc');
		const KEY = deriveKey(SIGNING_KEY);
		const pc = proxyConfig(fakeAs.url);

		// --- run 1: full sign-in through the real proxy routes ---
		const store1 = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
		store1.hydrate();
		const { app: app1 } = buildApp(makeDeps(fakeAs.url, store1, pc));
		const result = await runHostedFlow({ app: app1 });
		expect(result.accessToken).toBeTruthy();
		expect(result.refreshToken).toBeTruthy();

		const upstream1 = await resolveUpstreamBearer(result.accessToken, pc, store1);
		expect(upstream1).toMatch(/^access-auth-/);

		// the file was written and holds NO plaintext secret (encrypted at rest)
		expect(fs.existsSync(file)).toBe(true);
		const rawStr = fs.readFileSync(file).toString('latin1');
		expect(rawStr).not.toContain(upstream1);
		expect(rawStr).not.toContain('refresh-auth-');
		expect(rawStr).not.toContain(result.clientId);

		// --- simulate a restart: brand-new store hydrated from the same file ---
		const store2 = new PersistentProxyStore(new InMemoryProxyStore(), file, KEY);
		store2.hydrate();
		const { app: app2 } = buildApp(makeDeps(fakeAs.url, store2, pc));

		// #1a: the proxy access token still resolves its upstream token post-restart
		const upstream2 = await resolveUpstreamBearer(result.accessToken, pc, store2);
		expect(upstream2).toBe(upstream1);

		// #2: the registered client survived — /authorize reaches the consent page
		const prDoc = await request(app2).get('/.well-known/oauth-protected-resource');
		const resource = (prDoc.body as { resource: string }).resource;
		const authRes = await request(app2)
			.get('/mcp/authorize')
			.query({
				client_id: result.clientId,
				redirect_uri: result.redirectUri,
				state: 'restart-state',
				code_challenge: s256(randomVerifier()),
				code_challenge_method: 'S256',
				scope: 'mwoauth-authonly',
				resource,
			});
		expect(authRes.status).toBe(200);
		expect(authRes.text).toMatch(/Authorize application/);

		// #1b: refresh works post-restart (upstream refresh token + refreshId survived)
		const refreshRes = await request(app2).post('/mcp/token').type('form').send({
			grant_type: 'refresh_token',
			refresh_token: result.refreshToken,
		});
		expect(refreshRes.status).toBe(200);
		expect((refreshRes.body as { access_token?: string }).access_token).toBeTruthy();
		expect((refreshRes.body as { refresh_token?: string }).refresh_token).toBeTruthy();

		// reuse detection SURVIVES the restart: replaying the now-superseded token is rejected
		const replay = await request(app2).post('/mcp/token').type('form').send({
			grant_type: 'refresh_token',
			refresh_token: result.refreshToken,
		});
		expect(replay.status).toBe(400);

		fs.rmSync(dir, { recursive: true, force: true });
	});
});
