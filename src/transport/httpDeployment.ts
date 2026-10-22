import type { WikiConfig } from '../config/loadConfig.ts';
import { hasStaticCredentials, usesOAuthSignIn, type AuthPolicy } from '../runtime/authShape.ts';
import { evaluateBearerGuard } from './bearerGuard.ts';

export interface HttpDeploymentCheck {
	/** Why the HTTP transport must not start, if it must not. */
	refusal?: string;
	warnings: string[];
}

/** What the HTTP transport has to say about how it is deployed, before it serves. */
export function checkHttpDeployment(deployment: {
	wikis: Readonly<Record<string, WikiConfig>>;
	defaultWikiKey: string;
	auth: AuthPolicy;
	proxyEnabled: boolean;
}): HttpDeploymentCheck {
	const { wikis, defaultWikiKey, auth, proxyEnabled } = deployment;
	const warnings: string[] = [];

	const guard = evaluateBearerGuard(wikis, auth.staticFallback);
	if (guard.kind === 'block') {
		return {
			refusal:
				'HTTP transport refuses to start because static credentials are configured for wiki(s): ' +
				guard.wikis.join(', ') +
				'.\n' +
				'A request without an Authorization header would silently act as the configured identity, ' +
				'so writes could not be attributed to the caller that made them.\n' +
				'Remove `token`, `username`, and `password` from these wikis in config.json, ' +
				'or set MCP_ALLOW_STATIC_FALLBACK=true to acknowledge the shared-identity deployment shape.',
			warnings,
		};
	}
	if (guard.kind === 'override') {
		warnings.push(
			'MCP_ALLOW_STATIC_FALLBACK=true is set. Wiki(s) with static credentials: ' +
				guard.wikis.join(', ') +
				'. ' +
				'Requests without an Authorization header will act as the configured identity. ' +
				'This deployment cannot attribute writes to individual callers.',
		);
	}

	if (auth.bearerPassthrough) {
		warnings.push(
			proxyEnabled
				? 'MCP_ALLOW_BEARER_PASSTHROUGH=true is set but has no effect: hosted OAuth sign-in ' +
						'is configured, so a bearer is read as a token this server issued and a ' +
						'caller-supplied one is refused. Unset the variable.'
				: 'MCP_ALLOW_BEARER_PASSTHROUGH=true is set. A caller-supplied Authorization header ' +
						'is forwarded to MediaWiki as that caller. This is deprecated: MCP servers must ' +
						'not accept tokens that were not issued for them. Prefer the hosted OAuth ' +
						'sign-in, which issues this server its own tokens.',
		);
	}

	// A deployment can be configured so that nothing it serves can authenticate:
	// wikis that require OAuth, no hosted sign-in to mint a token, and no opted-in
	// forwarding to carry one. Nothing a client sends can fix that.
	if (!proxyEnabled && !auth.bearerPassthrough) {
		const stranded = Object.entries(wikis)
			.filter(([key, cfg]) => {
				const usableStatic = hasStaticCredentials(cfg) && auth.staticFallback;
				// A `private` DEFAULT wiki cannot be rescued by static credentials: the
				// route challenges a tokenless request before any credential is
				// resolved, so every request to such a deployment is answered 401.
				if (cfg.private === true && key === defaultWikiKey) {
					return true;
				}
				return (usesOAuthSignIn(cfg) || cfg.private === true) && !usableStatic;
			})
			.map(([key]) => key);
		if (stranded.length > 0) {
			warnings.push(
				'No way to authenticate to wiki(s): ' +
					stranded.join(', ') +
					'. They require a signed-in user, but the hosted OAuth sign-in is not configured ' +
					'and forwarding a caller-supplied token is off. Set MCP_PUBLIC_URL and ' +
					'MCP_OAUTH_JWT_SIGNING_KEY to enable hosted sign-in (see docs/deployment.md).',
			);
		}
	}

	return { warnings };
}
