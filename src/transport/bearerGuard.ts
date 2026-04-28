import type { WikiConfig } from '../config/loadConfig.js';

export interface BearerGuardEnv {
	MCP_ALLOW_STATIC_FALLBACK?: string;
}

export type BearerGuardResult =
	| { readonly kind: 'ok' }
	| { readonly kind: 'override'; readonly wikis: readonly string[] }
	| { readonly kind: 'block'; readonly wikis: readonly string[] };

function isNonEmptyString( value: unknown ): value is string {
	return typeof value === 'string' && value.length > 0;
}

export function hasStaticCredentials( wiki: WikiConfig ): boolean {
	if ( isNonEmptyString( wiki.token ) ) {
		return true;
	}
	return isNonEmptyString( wiki.username ) && isNonEmptyString( wiki.password );
}

export function evaluateBearerGuard(
	wikis: Readonly<Record<string, WikiConfig>>,
	env: BearerGuardEnv
): BearerGuardResult {
	const offenders = Object.entries( wikis )
		.filter( ( [ , w ] ) => hasStaticCredentials( w ) )
		.map( ( [ k ] ) => k );

	if ( offenders.length === 0 ) {
		return { kind: 'ok' };
	}
	if ( env.MCP_ALLOW_STATIC_FALLBACK === 'true' ) {
		return { kind: 'override', wikis: offenders };
	}
	return { kind: 'block', wikis: offenders };
}

export type AuthShape = 'anonymous' | 'static-credential' | 'bearer-passthrough';
export type Transport = 'stdio' | 'http';

export function classifyAuthShape(
	wikis: Readonly<Record<string, WikiConfig>>,
	transport: Transport
): AuthShape {
	const anyStatic = Object.values( wikis ).some( hasStaticCredentials );
	if ( anyStatic ) {
		return 'static-credential';
	}
	return transport === 'http' ? 'bearer-passthrough' : 'anonymous';
}
