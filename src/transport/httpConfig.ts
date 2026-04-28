export interface HttpConfig {
	host: string;
	port: number;
	allowedHosts: string[] | undefined;
	allowedOrigins: string[] | undefined;
}

export const LOCALHOST_HOSTS: readonly string[] = [ '127.0.0.1', 'localhost', '::1' ];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;

function resolveHost(): string {
	const raw = process.env.MCP_BIND;
	if ( raw === undefined ) {
		return DEFAULT_HOST;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? DEFAULT_HOST : trimmed;
}

function resolvePort(): number {
	const raw = process.env.PORT;
	if ( raw === undefined || raw === '' ) {
		return DEFAULT_PORT;
	}
	const parsed = Number.parseInt( raw, 10 );
	if ( !Number.isFinite( parsed ) || parsed <= 0 || parsed > MAX_PORT ) {
		return DEFAULT_PORT;
	}
	return parsed;
}

function resolveAllowedHosts(): string[] | undefined {
	const raw = process.env.MCP_ALLOWED_HOSTS;
	if ( raw === undefined || raw === '' ) {
		return undefined;
	}
	const entries = raw
		.split( ',' )
		.map( ( entry ) => entry.trim() )
		.filter( ( entry ) => entry !== '' );
	return entries.length === 0 ? undefined : entries;
}

// Default Origin allowlist when bound to localhost and no explicit MCP_ALLOWED_ORIGINS.
// Covers the three loopback spellings a browser fetch() may produce for the bound port.
function defaultLocalhostOrigins( port: number ): string[] {
	return [
		`http://localhost:${ port }`,
		`http://127.0.0.1:${ port }`,
		`http://[::1]:${ port }`
	];
}

function resolveAllowedOrigins( host: string, port: number ): string[] | undefined {
	const raw = process.env.MCP_ALLOWED_ORIGINS;
	if ( raw !== undefined && raw !== '' ) {
		const entries = raw
			.split( ',' )
			.map( ( entry ) => entry.trim() )
			.filter( ( entry ) => entry !== '' );
		if ( entries.length > 0 ) {
			return entries;
		}
	}
	if ( LOCALHOST_HOSTS.includes( host ) ) {
		return defaultLocalhostOrigins( port );
	}
	return undefined;
}

export function resolveHttpConfig(): HttpConfig {
	const host = resolveHost();
	const port = resolvePort();
	return {
		host,
		port,
		allowedHosts: resolveAllowedHosts(),
		allowedOrigins: resolveAllowedOrigins( host, port )
	};
}
