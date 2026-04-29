export interface HttpConfig {
	host: string;
	port: number;
	allowedHosts: string[] | undefined;
	allowedOrigins: string[] | undefined;
	maxRequestBody: string;
	warnings: string[];
}

export const LOCALHOST_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
export const DEFAULT_MAX_REQUEST_BODY = '1mb';

// Mirrors body-parser's size grammar: optional decimal number followed by an
// optional unit (bytes if omitted). Validating at startup prevents body-parser
// from silently treating a malformed value as "no limit".
const SIZE_PATTERN = /^\s*\d+(?:\.\d+)?\s*(?:b|kb|mb|gb|tb|pb)?\s*$/i;

function resolveHost(): string {
	const raw = process.env.MCP_BIND;
	if (raw === undefined) {
		return DEFAULT_HOST;
	}
	const trimmed = raw.trim();
	return trimmed === '' ? DEFAULT_HOST : trimmed;
}

function resolvePort(): number {
	const raw = process.env.PORT;
	if (raw === undefined || raw === '') {
		return DEFAULT_PORT;
	}
	const parsed = Number.parseInt(raw, 10);
	if (!Number.isFinite(parsed) || parsed <= 0 || parsed > MAX_PORT) {
		return DEFAULT_PORT;
	}
	return parsed;
}

function resolveAllowedHosts(): string[] | undefined {
	const raw = process.env.MCP_ALLOWED_HOSTS;
	if (raw === undefined || raw === '') {
		return undefined;
	}
	const entries = raw
		.split(',')
		.map((entry) => entry.trim())
		.filter((entry) => entry !== '');
	return entries.length === 0 ? undefined : entries;
}

// Default Origin allowlist when bound to localhost and no explicit MCP_ALLOWED_ORIGINS.
// Covers the three loopback spellings a browser fetch() may produce for the bound port.
function defaultLocalhostOrigins(port: number): string[] {
	return [`http://localhost:${port}`, `http://127.0.0.1:${port}`, `http://[::1]:${port}`];
}

function resolveAllowedOrigins(host: string, port: number): string[] | undefined {
	const raw = process.env.MCP_ALLOWED_ORIGINS;
	if (raw !== undefined && raw !== '') {
		const entries = raw
			.split(',')
			.map((entry) => entry.trim())
			.filter((entry) => entry !== '');
		if (entries.length > 0) {
			return entries;
		}
	}
	if (LOCALHOST_HOSTS.includes(host)) {
		return defaultLocalhostOrigins(port);
	}
	return undefined;
}

function resolveMaxRequestBody(): { value: string; warning?: string } {
	const raw = process.env.MCP_MAX_REQUEST_BODY;
	if (raw === undefined) {
		return { value: DEFAULT_MAX_REQUEST_BODY };
	}
	const trimmed = raw.trim();
	if (trimmed === '') {
		return { value: DEFAULT_MAX_REQUEST_BODY };
	}
	if (!SIZE_PATTERN.test(trimmed)) {
		return {
			value: DEFAULT_MAX_REQUEST_BODY,
			warning: `MCP_MAX_REQUEST_BODY=${raw} is not a recognised size; using default ${DEFAULT_MAX_REQUEST_BODY}`,
		};
	}
	if (parseFloat(trimmed) === 0) {
		return {
			value: DEFAULT_MAX_REQUEST_BODY,
			warning: `MCP_MAX_REQUEST_BODY=${raw} would reject all requests; using default ${DEFAULT_MAX_REQUEST_BODY}`,
		};
	}
	return { value: trimmed };
}

export function resolveHttpConfig(): HttpConfig {
	const host = resolveHost();
	const port = resolvePort();
	const body = resolveMaxRequestBody();
	const warnings: string[] = [];
	if (body.warning) {
		warnings.push(body.warning);
	}
	return {
		host,
		port,
		allowedHosts: resolveAllowedHosts(),
		allowedOrigins: resolveAllowedOrigins(host, port),
		maxRequestBody: body.value,
		warnings,
	};
}
