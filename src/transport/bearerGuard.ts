import type { WikiConfig } from '../config/loadConfig.ts';
import { hasStaticCredentials } from '../runtime/authShape.ts';

export type BearerGuardResult =
	| { readonly kind: 'ok' }
	| { readonly kind: 'override'; readonly wikis: readonly string[] }
	| { readonly kind: 'block'; readonly wikis: readonly string[] };

export function evaluateBearerGuard(
	wikis: Readonly<Record<string, WikiConfig>>,
	staticFallback: boolean,
): BearerGuardResult {
	const offenders = Object.entries(wikis)
		.filter(([, w]) => hasStaticCredentials(w))
		.map(([k]) => k);

	if (offenders.length === 0) {
		return { kind: 'ok' };
	}
	if (staticFallback) {
		return { kind: 'override', wikis: offenders };
	}
	return { kind: 'block', wikis: offenders };
}
