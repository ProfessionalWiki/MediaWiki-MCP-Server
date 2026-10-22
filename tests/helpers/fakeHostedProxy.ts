import type { HostedProxy } from '../../src/auth/authorizationServer/hostedProxy.ts';
import type { ProxyConfig } from '../../src/auth/authorizationServer/proxyConfig.ts';
import type { ProxyStore } from '../../src/auth/authorizationServer/proxyStore.ts';
import { buildRedirectPolicy } from '../../src/auth/authorizationServer/redirectPolicy.ts';
import { CimdResolver } from '../../src/auth/authorizationServer/cimd.ts';

// Trusts no client-id metadata host unless the suite passes its own resolver.
export function fakeHostedProxy(
	config: ProxyConfig,
	store: ProxyStore,
	cimdResolver?: CimdResolver,
): HostedProxy {
	return {
		config,
		store,
		redirectPolicy: buildRedirectPolicy(config.redirectAllowlist),
		cimdResolver:
			cimdResolver ??
			new CimdResolver(
				() => false,
				() => Promise.reject(new Error('no metadata host is trusted')),
			),
		sitename: 'Test Wiki',
	};
}
