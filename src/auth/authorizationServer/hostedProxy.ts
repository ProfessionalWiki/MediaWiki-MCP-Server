import type { ProxyConfig } from './proxyConfig.ts';
import type { ProxyStore } from './proxyStore.ts';
import { createProxyStore } from './proxyStorePersistence.ts';
import { buildRedirectPolicy } from './redirectPolicy.ts';
import { CimdResolver, buildCimdHostPredicate } from './cimd.ts';
import { fetchCimdDocument } from './cimdFetch.ts';

/** The hosted OAuth proxy: this server acting as the authorization server for one wiki. */
export interface HostedProxy {
	readonly config: ProxyConfig;
	readonly store: ProxyStore;
	/** Whether a client may register this redirect URI. */
	readonly redirectPolicy: (uri: string) => boolean;
	/** Resolves a URL `client_id` by fetching its metadata document. */
	readonly cimdResolver: CimdResolver;
	/** The proxy wiki's name, shown on the consent page. */
	readonly sitename: string;
}

export const AUTHORIZATION_SERVER_PATHS = {
	metadata: '/.well-known/oauth-authorization-server',
	metadataForMcp: '/.well-known/oauth-authorization-server/mcp',
	register: '/mcp/register',
	authorize: '/mcp/authorize',
	consent: '/mcp/consent',
	callback: '/mcp/oauth/callback',
	token: '/mcp/token',
} as const;

/** Hydrates the persisted store, so a restart keeps every user signed in. */
export function startHostedProxy(
	config: ProxyConfig,
	sitename: string,
	onPersistError: (err: Error) => void,
): HostedProxy {
	return {
		config,
		store: createProxyStore(config, { onError: onPersistError }),
		redirectPolicy: buildRedirectPolicy(config.redirectAllowlist),
		cimdResolver: new CimdResolver(
			buildCimdHostPredicate(config.cimdAllowedHosts),
			fetchCimdDocument,
		),
		sitename,
	};
}
