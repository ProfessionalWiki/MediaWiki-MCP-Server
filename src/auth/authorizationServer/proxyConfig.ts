export class ProxyConfigError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ProxyConfigError';
	}
}

export interface ProxyConfig {
	issuer: string;
	authorizeBase: string;
	tokenExchangeBase: string;
	scriptpath: string;
	callbackUrl: string;
	upstreamClientId: string;
	signingKey: string;
	consentTtlMs: number;
	tokenTtlMs: number;
}

const UPSTREAM_REFRESH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;
const DEFAULT_TOKEN_TTL_MS = 55 * 60 * 1000;
const DEFAULT_CONSENT_TTL_MS = 30 * 24 * 60 * 60 * 1000;

interface WikiSlice {
	server: string;
	scriptpath: string;
	oauth2ClientId?: string | null;
	publicServer?: string | null;
}

function stripTrailingSlash(u: string): string {
	return u.replace(/\/+$/, '');
}

export function resolveProxyConfig(
	_wikiKey: string,
	wiki: WikiSlice,
	env: NodeJS.ProcessEnv,
): ProxyConfig | null {
	const clientId = wiki.oauth2ClientId?.trim();
	const publicUrl = env.MCP_PUBLIC_URL?.trim();
	const signingKey = env.MCP_OAUTH_JWT_SIGNING_KEY?.trim();
	const transport = env.MCP_TRANSPORT ?? 'stdio';

	if (!clientId || !publicUrl || !signingKey || transport !== 'http') {
		return null;
	}

	let issuer: string;
	try {
		issuer = stripTrailingSlash(new URL(publicUrl).toString());
	} catch {
		throw new ProxyConfigError(`MCP_PUBLIC_URL is not a valid URL: ${publicUrl}`);
	}

	if (signingKey.length < 32) {
		throw new ProxyConfigError('MCP_OAUTH_JWT_SIGNING_KEY must be at least 32 characters.');
	}

	const tokenTtlMs = env.MCP_OAUTH_TOKEN_TTL
		? parseDurationMs(env.MCP_OAUTH_TOKEN_TTL)
		: DEFAULT_TOKEN_TTL_MS;
	if (tokenTtlMs > UPSTREAM_REFRESH_WINDOW_MS) {
		throw new ProxyConfigError('MCP_OAUTH_TOKEN_TTL exceeds the upstream refresh window.');
	}
	const consentTtlMs = env.MCP_OAUTH_CONSENT_TTL
		? parseDurationMs(env.MCP_OAUTH_CONSENT_TTL)
		: DEFAULT_CONSENT_TTL_MS;

	return {
		issuer,
		authorizeBase: stripTrailingSlash(wiki.publicServer?.trim() || wiki.server),
		tokenExchangeBase: stripTrailingSlash(wiki.server),
		scriptpath: wiki.scriptpath,
		callbackUrl: `${issuer}/oauth/callback`,
		upstreamClientId: clientId,
		signingKey,
		consentTtlMs,
		tokenTtlMs,
	};
}

function parseDurationMs(s: string): number {
	const m = /^(\d+)\s*([smhd])?$/.exec(s.trim());
	if (!m) {
		throw new ProxyConfigError(`Unparseable duration: ${s}`);
	}
	const n = Number(m[1]);
	const unit = m[2] ?? 's';
	const mult = { s: 1e3, m: 60e3, h: 3600e3, d: 86400e3 }[unit]!;
	return n * mult;
}
