import type { CallToolResult } from '@modelcontextprotocol/server';
import type { SharedContext } from './context.ts';
import type { ExtensionPack } from '../tools/extensions/types.ts';
import { extensionPacks, packToolRefusal } from '../tools/extensions/index.ts';
import { standardTools } from '../tools/standardTools.ts';
import { isWikiScoped } from './wikiArg.ts';
import { getRuntimeToken } from './requestContext.ts';
import { hasStaticCredentials, usesOAuthSignIn } from './authShape.ts';

// The wiki-mutating tools. Shared by reconcile's read-only rule and the
// per-call capability guard.
export const WRITE_TOOL_NAMES: readonly string[] = standardTools
	.filter(isWriteTool)
	.map((tool) => tool.name);

/**
 * Whether a tool changes a wiki, read from its own annotations so that a new
 * one is gated without being listed anywhere. A tool that is not wiki-scoped is
 * left out: the gate acts on the wiki a call resolves to, and only a
 * wiki-scoped tool resolves one.
 */
export function isWriteTool(tool: {
	readonly annotations: { readonly readOnlyHint: boolean };
	readonly wikiScoped?: boolean;
}): boolean {
	return !tool.annotations.readOnlyHint && isWikiScoped(tool);
}

const WRITE_TOOL_SET: ReadonlySet<string> = new Set(WRITE_TOOL_NAMES);

// toolName -> the extension pack that provides it.
const PACK_BY_TOOL: ReadonlyMap<string, ExtensionPack> = ((): ReadonlyMap<
	string,
	ExtensionPack
> => {
	const map = new Map<string, ExtensionPack>();
	for (const pack of extensionPacks) {
		for (const tool of pack.tools) {
			map.set(tool.name, pack);
		}
	}
	return map;
})();

/**
 * Verifies a wiki-scoped tool can run against the resolved wiki. Returns an
 * error CallToolResult to short-circuit dispatch, or undefined when the call
 * may proceed. Non-extension, non-write tools always return undefined.
 */
export async function checkWikiCapability(
	toolName: string,
	wikiKey: string,
	ctx: SharedContext,
): Promise<CallToolResult | undefined> {
	// HTTP transport: a call to an OAuth-only wiki with no usable token can only
	// fail downstream with an opaque error, so it is rejected up front with guidance
	// naming whichever action can actually resolve it. (On stdio the dispatcher's acquireToken gate drives OAuth, so
	// this never fires there.) On HTTP a wiki with static credentials only
	// coexists with a running server when MCP_ALLOW_STATIC_FALLBACK is set —
	// the startup bearer guard (evaluateBearerGuard) blocks startup otherwise —
	// so this guard need not re-consult that env var.
	//
	// When the hosted OAuth proxy is enabled, tokenless requests are served
	// anonymously (the /mcp handler no longer 401s them), so the blanket
	// OAuth-only rejection above is replaced by a narrower step-up: only WRITE
	// tools require a token, and the error carries the protected-resource URL so
	// the client can authenticate and retry.
	if (ctx.transport === 'http') {
		const cfg = ctx.wikis.get(wikiKey);
		if (cfg) {
			const pc = ctx.getProxyConfig?.() ?? null;
			const oauthOnly = usesOAuthSignIn(cfg);
			const hasStatic = hasStaticCredentials(cfg);
			const anonymous = getRuntimeToken(wikiKey) === undefined;
			if (pc) {
				// Sign-in yields tokens for the proxy's wiki only, so asking the caller to
				// authenticate could never let a write to another wiki through.
				if (WRITE_TOOL_SET.has(toolName) && wikiKey !== pc.wikiKey) {
					return ctx.format.permissionDenied(
						`Hosted sign-in covers wiki "${pc.wikiKey}" only, so write tools are not available on wiki "${wikiKey}".`,
					);
				}
				if (anonymous && WRITE_TOOL_SET.has(toolName)) {
					return ctx.format.error(
						'authentication',
						`Authentication required to use write tools. See ${pc.issuer}/.well-known/oauth-protected-resource to authenticate.`,
					);
				}
			} else if (oauthOnly && !hasStatic && anonymous) {
				// Two different situations, and the caller can only act on one. With
				// forwarding opted into, supplying a token works and there is no
				// discovery document to point at. Without it, nothing the caller sends
				// is accepted, so the message names the operator's action instead of
				// asking for a token the transport would refuse.
				return ctx.format.error(
					'authentication',
					ctx.auth.bearerPassthrough
						? `Wiki "${wikiKey}" requires an authenticated user. Send an Authorization: Bearer ` +
								'token obtained from that wiki for this caller.'
						: `Wiki "${wikiKey}" requires an authenticated user, and this server has no way ` +
								'to obtain one: hosted OAuth sign-in is not configured. The operator needs to ' +
								'enable it (MCP_PUBLIC_URL and MCP_OAUTH_JWT_SIGNING_KEY).',
				);
			}
		}
	}
	const pack = PACK_BY_TOOL.get(toolName);
	if (pack) {
		const refusal = packToolRefusal(pack, toolName, await ctx.wikiProbe.inspect(wikiKey), wikiKey);
		if (refusal !== undefined) {
			return ctx.format.invalidInput(refusal);
		}
	}
	if (WRITE_TOOL_SET.has(toolName)) {
		const config = ctx.wikis.get(wikiKey);
		if (config?.readOnly === true) {
			return ctx.format.permissionDenied(`Wiki "${wikiKey}" is configured read-only.`);
		}
	}
	return undefined;
}
