import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { startHostedProxy } from '../../../src/auth/authorizationServer/hostedProxy.ts';
import { parseRedirectAllowlist } from '../../../src/auth/authorizationServer/redirectPolicy.ts';
import { fakeProxyConfig } from '../../helpers/fakeProxyConfig.ts';

const ignorePersistError = (): void => {};

describe('startHostedProxy', () => {
	let dir: string;
	beforeEach(() => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-hosted-proxy-'));
		vi.stubEnv('MCP_OAUTH_PROXY_STORE_FILE', path.join(dir, 'proxy-store.enc'));
	});
	afterEach(() => {
		fs.rmSync(dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});

	it('lets a client register a redirect on the operator allowlist', () => {
		const config = fakeProxyConfig({
			redirectAllowlist: parseRedirectAllowlist('https://app.example/oauth/*'),
		});

		const proxy = startHostedProxy(config, 'Test Wiki', ignorePersistError);

		expect(proxy.redirectPolicy('https://app.example/oauth/callback')).toBe(true);
		expect(proxy.redirectPolicy('https://other.example/oauth/callback')).toBe(false);
	});

	it('keeps the sign-ins an earlier start persisted', () => {
		const config = fakeProxyConfig();
		const earlier = startHostedProxy(config, 'Test Wiki', ignorePersistError);
		const id = earlier.store.putUpstreamToken({ accessToken: 'wiki-token', expiresAt: 1 });

		const restarted = startHostedProxy(config, 'Test Wiki', ignorePersistError);

		expect(restarted.store.getUpstreamToken(id)?.accessToken).toBe('wiki-token');
	});
});
