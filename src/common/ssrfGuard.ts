import { lookup } from 'node:dns/promises';
import type { LookupAddress } from 'node:dns';
import { Agent as HttpAgent } from 'node:http';
import { Agent as HttpsAgent } from 'node:https';
// eslint-disable-next-line n/no-missing-import
import ipaddr from 'ipaddr.js';

// ipaddr.js .range() classifies most reserved space correctly, but leaves
// these as 'unicast' in v1.9.1. We treat them as non-public explicitly.
const EXTRA_BLOCKED_V4: Record<string, [ipaddr.IPv4, number]> = {
	benchmarking: [ ipaddr.IPv4.parse( '198.18.0.0' ), 15 ]
};
const EXTRA_BLOCKED_V6: Record<string, [ipaddr.IPv6, number]> = {
	deprecatedSiteLocal: [ ipaddr.IPv6.parse( 'fec0::' ), 10 ],
	deprecated6bone: [ ipaddr.IPv6.parse( '3ffe::' ), 16 ]
};

export async function assertPublicDestination(
	urlString: string
): Promise<LookupAddress[]> {
	// MediaWiki's siteinfo.general.server uses protocol-relative URLs (e.g.
	// '//en.wikipedia.org'). Normalise to https so the guard accepts them.
	const normalized = urlString.startsWith( '//' ) ? 'https:' + urlString : urlString;
	const url = new URL( normalized );
	if ( url.protocol !== 'https:' && url.protocol !== 'http:' ) {
		throw new Error(
			`Refusing to fetch URL with unsupported scheme "${ url.protocol }": ${ urlString }`
		);
	}

	const hostname = url.hostname.startsWith( '[' ) && url.hostname.endsWith( ']' ) ?
		url.hostname.slice( 1, -1 ) :
		url.hostname;

	const addresses = await lookup( hostname, { all: true } );
	if ( addresses.length === 0 ) {
		throw new Error(
			`DNS lookup for "${ hostname }" returned no addresses: ${ normalized }`
		);
	}
	for ( const { address } of addresses ) {
		assertAddressIsUnicast( address, normalized );
	}
	return addresses;
}

export function buildPinnedAgent(
	urlString: string,
	addresses: LookupAddress[]
): HttpAgent | HttpsAgent {
	const url = new URL( urlString );
	// The Agent's lookup is invoked by net.connect for each TCP connection, so
	// returning our pre-resolved addresses ensures fetch() cannot re-resolve
	// the hostname into a different (private) address between validation and
	// connection. SNI and the Host header are derived from the original URL,
	// so HTTPS and virtual-hosted HTTP still work correctly.
	//
	// Pinning assumes direct connections. A future HTTPS_PROXY / CONNECT-tunnel
	// Agent would bypass this lookup (the proxy resolves the hostname) and
	// would need its own SSRF defense at the proxy layer.
	const pinnedLookup = (
		_hostname: string,
		options: { all?: boolean },
		callback: (
			err: NodeJS.ErrnoException | null,
			addressOrAll: string | LookupAddress[],
			family?: number
		) => void
	): void => {
		if ( options.all ) {
			callback( null, addresses );
			return;
		}
		const first = addresses[ 0 ];
		callback( null, first.address, first.family );
	};

	const AgentCtor = url.protocol === 'https:' ? HttpsAgent : HttpAgent;
	return new AgentCtor( { lookup: pinnedLookup } );
}

function assertAddressIsUnicast( address: string, urlString: string ): void {
	let parsed: ipaddr.IPv4 | ipaddr.IPv6;
	try {
		parsed = ipaddr.parse( address );
	} catch {
		throw new Error(
			`Refusing to fetch URL resolving to unparseable address "${ address }": ${ urlString }`
		);
	}

	if ( parsed.kind() === 'ipv6' && ( parsed as ipaddr.IPv6 ).isIPv4MappedAddress() ) {
		parsed = ( parsed as ipaddr.IPv6 ).toIPv4Address();
	}

	const range = parsed.range();
	if ( range !== 'unicast' ) {
		throw new Error(
			`Refusing to fetch URL resolving to non-public address ${ address } (${ range }): ${ urlString }`
		);
	}

	const extraMatch = parsed.kind() === 'ipv4' ?
		ipaddr.subnetMatch( parsed as ipaddr.IPv4, EXTRA_BLOCKED_V4, 'unicast' ) :
		ipaddr.subnetMatch( parsed as ipaddr.IPv6, EXTRA_BLOCKED_V6, 'unicast' );
	if ( extraMatch !== 'unicast' ) {
		throw new Error(
			`Refusing to fetch URL resolving to non-public address ${ address } (${ extraMatch }): ${ urlString }`
		);
	}
}
