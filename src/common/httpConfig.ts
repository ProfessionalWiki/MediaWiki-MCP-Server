export interface HttpConfig {
	host: string;
	port: number;
	allowedHosts: string[] | undefined;
}

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

export function resolveHttpConfig(): HttpConfig {
	return {
		host: resolveHost(),
		port: resolvePort(),
		allowedHosts: resolveAllowedHosts()
	};
}
