import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('node:dns/promises', () => ({
	lookup: vi.fn(),
}));

import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
import { lookup } from 'node:dns/promises';
import { assertPublicDestination, buildPinnedAgent } from '../../src/transport/ssrfGuard.js';

describe('ssrfGuard.assertPublicDestination', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('rejects a non-http(s) scheme', async () => {
		await expect(assertPublicDestination('file:///etc/passwd')).rejects.toThrow(/scheme/i);
	});

	it('rejects an IPv4 loopback literal', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '127.0.0.1', family: 4 }]);
		await expect(assertPublicDestination('http://127.0.0.1/')).rejects.toThrow(/127\.0\.0\.1/);
	});

	it('rejects the cloud metadata link-local address', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '169.254.169.254', family: 4 }]);
		await expect(
			assertPublicDestination('http://169.254.169.254/latest/meta-data/'),
		).rejects.toThrow(/169\.254\.169\.254/);
	});

	it('rejects a hostname resolving to RFC1918 space', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
		await expect(assertPublicDestination('https://internal.example/')).rejects.toThrow(
			/10\.0\.0\.5/,
		);
	});

	it('rejects CGNAT and other non-unicast v4 ranges', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '100.64.0.1', family: 4 }]);
		await expect(assertPublicDestination('https://cgnat.example/')).rejects.toThrow();
	});

	it('rejects IPv6 loopback', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '::1', family: 6 }]);
		await expect(assertPublicDestination('http://[::1]/')).rejects.toThrow(/::1/);
	});

	it('rejects IPv6 unique-local (fc00::/7)', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: 'fd12:3456:789a::1', family: 6 }]);
		await expect(assertPublicDestination('https://ula.example/')).rejects.toThrow();
	});

	it('unwraps IPv4-mapped IPv6 and rejects underlying private v4', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '::ffff:127.0.0.1', family: 6 }]);
		await expect(assertPublicDestination('https://mapped.example/')).rejects.toThrow(/loopback/);
	});

	it('rejects when any resolved address is private in a dual-stack result', async () => {
		vi.mocked(lookup).mockResolvedValue([
			{ address: '93.184.216.34', family: 4 },
			{ address: '::1', family: 6 },
		]);
		await expect(assertPublicDestination('https://dualstack.example/')).rejects.toThrow(/::1/);
	});

	it('returns the resolved addresses for a public hostname', async () => {
		const addrs = [
			{ address: '93.184.216.34', family: 4 },
			{ address: '2606:2800:220:1:248:1893:25c8:1946', family: 6 },
		];
		vi.mocked(lookup).mockResolvedValue(addrs);

		const result = await assertPublicDestination('https://example.com/wiki/Main_Page');

		expect(result).toEqual(addrs);
	});

	it('rejects IPv4 benchmarking range 198.18.0.0/15 (RFC 2544)', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '198.18.0.1', family: 4 }]);
		await expect(assertPublicDestination('https://bench.example/')).rejects.toThrow(
			/198\.18\.0\.1/,
		);
	});

	it('rejects deprecated IPv6 site-local fec0::/10', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: 'fec0::1', family: 6 }]);
		await expect(assertPublicDestination('https://sitelocal.example/')).rejects.toThrow(/fec0::1/);
	});

	it('rejects deprecated IPv6 6bone 3ffe::/16', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '3ffe:1234::1', family: 6 }]);
		await expect(assertPublicDestination('https://sixbone.example/')).rejects.toThrow(
			/3ffe:1234::1/,
		);
	});

	it('accepts a protocol-relative URL (MediaWiki siteinfo shape) by assuming https', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '93.184.216.34', family: 4 }]);

		const result = await assertPublicDestination('//en.wikipedia.org');

		expect(result).toEqual([{ address: '93.184.216.34', family: 4 }]);
		expect(lookup).toHaveBeenCalledWith('en.wikipedia.org', { all: true });
	});

	it('rejects when DNS lookup returns no addresses', async () => {
		vi.mocked(lookup).mockResolvedValue([]);
		await expect(assertPublicDestination('https://empty.example/')).rejects.toThrow(
			/no addresses/i,
		);
	});

	it('surfaces DNS lookup failures to the caller', async () => {
		vi.mocked(lookup).mockRejectedValue(
			Object.assign(new Error('getaddrinfo ENOTFOUND nope.invalid'), { code: 'ENOTFOUND' }),
		);
		await expect(assertPublicDestination('https://nope.invalid/')).rejects.toThrow(/ENOTFOUND/);
	});
});

describe('ssrfGuard.assertPublicDestination with MCP_TRUSTED_HOSTS', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	afterEach(() => {
		delete process.env.MCP_TRUSTED_HOSTS;
	});

	it('allows a trusted host that resolves to a private IP, still returning the addresses for pinning', async () => {
		process.env.MCP_TRUSTED_HOSTS = 'mediawiki.svc';
		const addrs = [{ address: '172.18.0.5', family: 4 }];
		vi.mocked(lookup).mockResolvedValue(addrs);

		const result = await assertPublicDestination('http://mediawiki.svc:80/w/api.php');

		expect(result).toEqual(addrs);
		// Still resolves the name — pinning (buildPinnedAgent) depends on these addresses.
		expect(lookup).toHaveBeenCalledWith('mediawiki.svc', { all: true });
	});

	it('still rejects a non-listed private host while an allowlist is set', async () => {
		process.env.MCP_TRUSTED_HOSTS = 'mediawiki.svc';
		vi.mocked(lookup).mockResolvedValue([{ address: '10.0.0.5', family: 4 }]);
		await expect(assertPublicDestination('http://other.svc/')).rejects.toThrow(/10\.0\.0\.5/);
	});

	it('matches the allowlist exactly, not as a suffix (no mediawiki.svc.evil.com bypass)', async () => {
		process.env.MCP_TRUSTED_HOSTS = 'mediawiki.svc';
		vi.mocked(lookup).mockResolvedValue([{ address: '172.18.0.5', family: 4 }]);
		await expect(assertPublicDestination('http://mediawiki.svc.evil.com/')).rejects.toThrow(
			/172\.18\.0\.5/,
		);
	});

	it('still requires DNS to resolve to at least one address for a trusted host', async () => {
		process.env.MCP_TRUSTED_HOSTS = 'mediawiki.svc';
		vi.mocked(lookup).mockResolvedValue([]);
		await expect(assertPublicDestination('http://mediawiki.svc/')).rejects.toThrow(/no addresses/i);
	});

	it('honours a host:port entry only for the matching port', async () => {
		process.env.MCP_TRUSTED_HOSTS = 'mediawiki.svc:8080';
		vi.mocked(lookup).mockResolvedValue([{ address: '172.18.0.5', family: 4 }]);
		await expect(assertPublicDestination('http://mediawiki.svc:8080/')).resolves.toEqual([
			{ address: '172.18.0.5', family: 4 },
		]);
		await expect(assertPublicDestination('http://mediawiki.svc:9999/')).rejects.toThrow(
			/172\.18\.0\.5/,
		);
	});

	it('trims and case-folds comma-separated entries', async () => {
		process.env.MCP_TRUSTED_HOSTS = ' Foo.Internal , Mediawiki.SVC ';
		vi.mocked(lookup).mockResolvedValue([{ address: '172.18.0.5', family: 4 }]);
		await expect(assertPublicDestination('http://mediawiki.svc/')).resolves.toEqual([
			{ address: '172.18.0.5', family: 4 },
		]);
	});

	it('has no effect when unset (guard stays on for private IPs)', async () => {
		vi.mocked(lookup).mockResolvedValue([{ address: '172.18.0.5', family: 4 }]);
		await expect(assertPublicDestination('http://mediawiki.svc/')).rejects.toThrow(/172\.18\.0\.5/);
	});
});

describe('ssrfGuard.buildPinnedAgent', () => {
	const addrs = [
		{ address: '93.184.216.34', family: 4 as const },
		{ address: '2606:2800:220::1', family: 6 as const },
	];

	it('returns an https.Agent for an https URL', () => {
		const agent = buildPinnedAgent('https://example.com/', addrs);
		expect(agent).toBeInstanceOf(HttpsAgent);
	});

	it('returns an http.Agent for an http URL', () => {
		const agent = buildPinnedAgent('http://example.com/', addrs);
		expect(agent).toBeInstanceOf(HttpAgent);
		expect(agent).not.toBeInstanceOf(HttpsAgent);
	});

	it('lookup returns all pre-resolved addresses when options.all is true', () => {
		const agent = buildPinnedAgent('https://example.com/', addrs);
		return new Promise<void>((resolve, reject) => {
			// agent.options.lookup is the function we installed.
			(agent as unknown as { options: { lookup: Function } }).options.lookup(
				'different.example',
				{ all: true },
				(err: Error | null, result: unknown) => {
					try {
						expect(err).toBeNull();
						expect(result).toEqual(addrs);
						resolve();
					} catch (e) {
						reject(e);
					}
				},
			);
		});
	});

	it('lookup returns the first address when options.all is false', () => {
		const agent = buildPinnedAgent('https://example.com/', addrs);
		return new Promise<void>((resolve, reject) => {
			(agent as unknown as { options: { lookup: Function } }).options.lookup(
				'different.example',
				{ all: false },
				(err: Error | null, address: string, family: number) => {
					try {
						expect(err).toBeNull();
						expect(address).toBe('93.184.216.34');
						expect(family).toBe(4);
						resolve();
					} catch (e) {
						reject(e);
					}
				},
			);
		});
	});
});
