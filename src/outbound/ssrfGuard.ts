import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import type { LookupFunction } from 'node:net';
import { Agent } from 'undici';
import ipaddr from 'ipaddr.js';

export class SsrfValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'SsrfValidationError';
	}
}

// ipaddr.js .range() classifies most reserved space correctly, but still
// returns 'unicast' for these deprecated IPv6 blocks. Treat them as non-public.
const EXTRA_BLOCKED_V6: Record<string, [ipaddr.IPv6, number]> = {
	deprecatedSiteLocal: [ipaddr.IPv6.parse('fec0::'), 10],
	deprecated6bone: [ipaddr.IPv6.parse('3ffe::'), 16],
};

// Operator-controlled allowlist (MCP_TRUSTED_HOSTS) of hosts whose resolved
// address is permitted to be non-public — e.g. an internal Docker-network alias
// like `mediawiki.svc` the operator deliberately pointed the server at. Read from
// the environment on each call so it stays testable and reflects runtime config.
// Entries are comma-separated, trimmed and case-folded. A bare host (e.g.
// `mediawiki.svc`) matches that host on any port; a `host:port` entry matches
// only that port. Matching is exact — no wildcard/suffix — so a public host such
// as `mediawiki.svc.attacker.com` can never match a `mediawiki.svc` entry.
function readTrustedHosts(): Set<string> {
	const raw = process.env.MCP_TRUSTED_HOSTS;
	if (raw === undefined || raw === '') {
		return new Set();
	}
	return new Set(
		raw
			.split(',')
			.map((entry) => entry.trim().toLowerCase())
			.filter((entry) => entry !== ''),
	);
}

export async function assertPublicDestination(urlString: string): Promise<LookupAddress[]> {
	// MediaWiki's siteinfo.general.server uses protocol-relative URLs (e.g.
	// '//en.wikipedia.org'). Normalise to https so the guard accepts them.
	const normalized = urlString.startsWith('//') ? 'https:' + urlString : urlString;
	const url = new URL(normalized);
	if (url.protocol !== 'https:' && url.protocol !== 'http:') {
		throw new SsrfValidationError(
			`Refusing to fetch URL with unsupported scheme "${url.protocol}": ${urlString}`,
		);
	}

	const hostname =
		url.hostname.startsWith('[') && url.hostname.endsWith(']')
			? url.hostname.slice(1, -1)
			: url.hostname;

	const addresses = await lookup(hostname, { all: true });
	if (addresses.length === 0) {
		throw new SsrfValidationError(
			`DNS lookup for "${hostname}" returned no addresses: ${normalized}`,
		);
	}

	// Operator-allowlisted host: skip ONLY the public-address assertion. We still
	// resolved the name above and still return those addresses, so fetchCore pins
	// them via buildPinnedAgent — preserving DNS-rebinding/TOCTOU defense even for
	// the trusted host. url.host omits a protocol-default port (so a bare-host
	// entry matches default-port URLs); the stripped hostname matches any port.
	const trusted = readTrustedHosts();
	if (
		trusted.size > 0 &&
		(trusted.has(hostname.toLowerCase()) || trusted.has(url.host.toLowerCase()))
	) {
		return addresses;
	}

	for (const { address } of addresses) {
		assertAddressIsUnicast(address, normalized);
	}
	return addresses;
}

/**
 * A dispatcher that connects only to `addresses`, so a request cannot re-resolve
 * its hostname into a different (private) address between validation and
 * connection. SNI and the Host header still come from the URL.
 */
export function buildPinnedAgent(addresses: LookupAddress[]): Agent {
	// Pinning assumes direct connections: a proxy would resolve the hostname
	// itself and need its own SSRF defense.
	const pinnedLookup: LookupFunction = (_hostname, options, callback) => {
		if (options.all === true) {
			callback(null, addresses);
			return;
		}
		const first = addresses[0];
		callback(null, first.address, first.family);
	};
	return new Agent({ connect: { lookup: pinnedLookup } });
}

function assertAddressIsUnicast(address: string, urlString: string): void {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse(address);
	} catch {
		throw new SsrfValidationError(
			`Refusing to fetch URL resolving to unparseable address "${address}": ${urlString}`,
		);
	}

	if (
		parsed.kind() === 'ipv6' &&
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by parsed.kind() === 'ipv6'; ipaddr.js doesn't expose a type predicate
		(parsed as ipaddr.IPv6).isIPv4MappedAddress()
	) {
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- narrowed by parsed.kind() === 'ipv6'; ipaddr.js doesn't expose a type predicate
		parsed = (parsed as ipaddr.IPv6).toIPv4Address();
	}

	const range = parsed.range();
	if (range !== 'unicast') {
		throw new SsrfValidationError(nonPublicAddressMessage(address, range, urlString));
	}

	if (parsed.kind() === 'ipv6') {
		const extraMatch = ipaddr.subnetMatch(parsed, EXTRA_BLOCKED_V6, 'unicast');
		if (extraMatch !== 'unicast') {
			throw new SsrfValidationError(nonPublicAddressMessage(address, extraMatch, urlString));
		}
	}
}

// Names the remedy because this reaches tool output as well as the operator's
// logs: only the operator can lift the refusal, and no tool argument can.
function nonPublicAddressMessage(address: string, range: string, urlString: string): string {
	return (
		`Refusing to fetch URL resolving to non-public address ${address} (${range}); ` +
		`the server operator must add the host to MCP_TRUSTED_HOSTS to allow it: ${urlString}`
	);
}
