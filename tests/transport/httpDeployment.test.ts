import { describe, it, expect } from 'vitest';
import { checkHttpDeployment } from '../../src/transport/httpDeployment.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';

function wiki(overrides: Partial<WikiConfig> = {}): WikiConfig {
	return {
		sitename: 'Example',
		server: 'https://example.org',
		articlepath: '/wiki',
		scriptpath: '/w',
		...overrides,
	};
}

function check(
	wikis: Record<string, WikiConfig>,
	options: { env?: NodeJS.ProcessEnv; proxyEnabled?: boolean } = {},
) {
	return checkHttpDeployment({
		wikis,
		defaultWikiKey: Object.keys(wikis)[0],
		env: options.env ?? {},
		proxyEnabled: options.proxyEnabled ?? false,
	});
}

describe('checkHttpDeployment', () => {
	it('has nothing to say about a public wiki without credentials', () => {
		expect(check({ main: wiki() })).toEqual({ warnings: [] });
	});

	it('refuses to start while a wiki has static credentials, naming it and the opt-in', () => {
		const result = check({ main: wiki(), staff: wiki({ username: 'Bot', password: 'pw' }) });

		expect(result.refusal).toContain('staff');
		expect(result.refusal).toContain('MCP_ALLOW_STATIC_FALLBACK=true');
	});

	it('warns instead of refusing once the shared identity is opted into', () => {
		const result = check(
			{ staff: wiki({ token: 'abc' }) },
			{ env: { MCP_ALLOW_STATIC_FALLBACK: 'true' } },
		);

		expect(result.refusal).toBeUndefined();
		expect(result.warnings.join('\n')).toContain('cannot attribute writes');
	});

	it('warns that bearer passthrough is deprecated when hosted sign-in is not configured', () => {
		const result = check({ main: wiki() }, { env: { MCP_ALLOW_BEARER_PASSTHROUGH: 'true' } });

		expect(result.warnings.join('\n')).toContain('deprecated');
	});

	it('warns that bearer passthrough has no effect alongside hosted sign-in', () => {
		const result = check(
			{ main: wiki({ oauth2ClientId: 'client' }) },
			{ env: { MCP_ALLOW_BEARER_PASSTHROUGH: 'true' }, proxyEnabled: true },
		);

		expect(result.warnings.join('\n')).toContain('has no effect');
	});

	it('warns about a wiki that requires sign-in when nothing can sign a caller in', () => {
		const result = check({ main: wiki(), members: wiki({ oauth2ClientId: 'client' }) });

		expect(result.warnings.join('\n')).toContain('No way to authenticate to wiki(s): members.');
	});

	it('leaves a sign-in wiki alone when hosted sign-in is configured', () => {
		const result = check({ main: wiki({ oauth2ClientId: 'client' }) }, { proxyEnabled: true });

		expect(result.warnings).toEqual([]);
	});

	it('counts static credentials as a way in, once opted into', () => {
		const result = check(
			{ main: wiki(), members: wiki({ private: true, token: 'abc' }) },
			{ env: { MCP_ALLOW_STATIC_FALLBACK: 'true' } },
		);

		expect(result.warnings.join('\n')).not.toContain('No way to authenticate');
	});

	// The route challenges a tokenless request to a private default wiki before
	// any credential is resolved, so static credentials cannot answer it.
	it('counts a private default wiki as unreachable even with static credentials allowed', () => {
		const result = check(
			{ main: wiki({ private: true, token: 'abc' }) },
			{ env: { MCP_ALLOW_STATIC_FALLBACK: 'true' } },
		);

		expect(result.warnings.join('\n')).toContain('No way to authenticate to wiki(s): main.');
	});
});
