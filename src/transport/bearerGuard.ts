import type { WikiConfig } from '../config/loadConfig.js';
import { hasStaticCredentials } from '../runtime/authShape.js';

export interface BearerGuardEnv {
	MCP_ALLOW_STATIC_FALLBACK?: string;
}

export type BearerGuardResult =
	| { readonly kind: 'ok' }
	| { readonly kind: 'override'; readonly wikis: readonly string[] }
	| { readonly kind: 'block'; readonly wikis: readonly string[] };

export function evaluateBearerGuard(
	wikis: Readonly<Record<string, WikiConfig>>,
	env: BearerGuardEnv,
): BearerGuardResult {
	const offenders = Object.entries(wikis)
		.filter(([, w]) => hasStaticCredentials(w))
		.map(([k]) => k);

	if (offenders.length === 0) {
		return { kind: 'ok' };
	}
	if (env.MCP_ALLOW_STATIC_FALLBACK === 'true') {
		return { kind: 'override', wikis: offenders };
	}
	return { kind: 'block', wikis: offenders };
}
