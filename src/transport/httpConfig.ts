import type { RateLimitSettings } from './rateLimit.ts';

export interface HttpConfig {
	host: string;
	port: number;
	allowedHosts: string[] | undefined;
	// Always an array, never undefined: the Origin guard is mounted
	// unconditionally, and an empty allowlist means "refuse every cross-origin
	// request", which is the safe default rather than an absent control.
	allowedOrigins: string[];
	maxRequestBody: string;
	// null when the operator disabled rate limiting with MCP_RATE_LIMIT=0.
	rateLimit: RateLimitSettings | null;
	warnings: string[];
}

export const LOCALHOST_HOSTS: readonly string[] = ['127.0.0.1', 'localhost', '::1'];

const DEFAULT_HOST = '127.0.0.1';
const DEFAULT_PORT = 3000;
const MAX_PORT = 65535;
const DEFAULT_MAX_REQUEST_BODY = '1mb';

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

// The Origin allowlist: the operator's explicit list, or the loopback spellings
// for a local bind. Any other bind gets an empty list, which refuses every
// request carrying an Origin while leaving requests without one — every
// non-browser MCP client — untouched. Nothing else is inferred: MCP_PUBLIC_URL
// names this server's OAuth issuer, which in the usual topology is the wiki's
// own host, and a host that serves user-editable JavaScript must not become a
// browser-origin allowlist as a side effect of configuring sign-in.
function resolveAllowedOrigins(host: string, port: number): string[] {
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
	return [];
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

const DEFAULT_RATE_LIMIT = 30;
const DEFAULT_ANONYMOUS_RATE_LIMIT = 100;

// Accepts a non-negative number; undefined means unset, null means unparseable.
function parseRateValue(raw: string | undefined): number | null | undefined {
	if (raw === undefined || raw.trim() === '') {
		return undefined;
	}
	const parsed = Number(raw);
	return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

// Rate limiting for tools/call, on by default. MCP_RATE_LIMIT=0 disables it
// entirely; MCP_RATE_LIMIT_ANONYMOUS=0 leaves anonymous traffic unlimited while
// signed-in callers stay limited. Bursts default to twice the sustained rate,
// the headroom an agent firing a batch of calls needs; only the per-caller
// burst is separately tunable.
function resolveRateLimit(): { value: RateLimitSettings | null; warnings: string[] } {
	const warnings: string[] = [];
	const read = (name: string, fallback: number): number => {
		const parsed = parseRateValue(process.env[name]);
		if (parsed === null) {
			warnings.push(
				`${name}=${process.env[name]} is not a non-negative number; using default ${fallback}`,
			);
			return fallback;
		}
		return parsed ?? fallback;
	};
	const rate = read('MCP_RATE_LIMIT', DEFAULT_RATE_LIMIT);
	if (rate === 0) {
		return { value: null, warnings };
	}
	const burst = read('MCP_RATE_LIMIT_BURST', rate * 2);
	const anonymousRate = read('MCP_RATE_LIMIT_ANONYMOUS', DEFAULT_ANONYMOUS_RATE_LIMIT);
	return {
		value: {
			ratePerSecond: rate,
			burst: Math.max(1, burst),
			anonymousRatePerSecond: anonymousRate,
			anonymousBurst: Math.max(1, anonymousRate * 2),
		},
		warnings,
	};
}

export function resolveHttpConfig(): HttpConfig {
	const host = resolveHost();
	const port = resolvePort();
	const body = resolveMaxRequestBody();
	const rateLimit = resolveRateLimit();
	const warnings: string[] = [...rateLimit.warnings];
	if (body.warning) {
		warnings.push(body.warning);
	}
	// HTTP serving is per-request as of the 2026-07-28 MCP revision: there are
	// no sessions left to expire, so the knob is obsolete. Warn rather than
	// silently ignore a value still pinned in a deployment manifest.
	if (process.env.MCP_SESSION_IDLE_TIMEOUT !== undefined) {
		warnings.push(
			'MCP_SESSION_IDLE_TIMEOUT is obsolete: HTTP serving is per-request and sessions ' +
				'no longer exist. Remove it from the environment.',
		);
	}
	return {
		host,
		port,
		allowedHosts: resolveAllowedHosts(),
		allowedOrigins: resolveAllowedOrigins(host, port),
		maxRequestBody: body.value,
		rateLimit: rateLimit.value,
		warnings,
	};
}
