import type { CallToolResult } from '@modelcontextprotocol/server';
import type { ToolContext } from './context.ts';
import type { ExtensionPack } from '../tools/extensions/types.ts';
import { extensionPacks } from '../tools/extensions/index.ts';
import { getRuntimeToken } from './requestContext.ts';
import { bearerPassthroughEnabled, hasStaticCredentials } from './authShape.ts';

const CORE_WRITE_TOOL_NAMES: readonly string[] = [
	'create-page',
	'move-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url',
	'update-file',
	'update-file-from-url',
];

const EXTENSION_WRITE_TOOL_NAMES: readonly string[] = extensionPacks.flatMap((pack) =>
	pack.tools.filter((tool) => tool.annotations.readOnlyHint === false).map((tool) => tool.name),
);

// The wiki-mutating tools. Shared by reconcile's read-only rule and the
// per-call capability guard.
export const WRITE_TOOL_NAMES: readonly string[] = [
	...CORE_WRITE_TOOL_NAMES,
	...EXTENSION_WRITE_TOOL_NAMES,
];

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
	ctx: ToolContext,
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
			const oauthOnly = typeof cfg.oauth2ClientId === 'string' && cfg.oauth2ClientId.trim() !== '';
			const hasStatic = hasStaticCredentials(cfg);
			const anonymous = getRuntimeToken() === undefined;
			if (pc) {
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
					bearerPassthroughEnabled()
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
		const present = await ctx.wikiProbe.hasAnyExtension(wikiKey, pack.extensionNames);
		if (!present) {
			// hasAnyExtension is false both when the extension is absent and when
			// the probe failed; inspect() (same cache entry) tells them apart so the
			// error doesn't claim "not installed" for a wiki that is merely down.
			const { reachable } = await ctx.wikiProbe.inspect(wikiKey);
			const reason = reachable
				? `The ${pack.extensionNames[0]} extension is not installed on wiki "${wikiKey}".`
				: `Wiki "${wikiKey}" could not be reached to check for the ${pack.extensionNames[0]} extension.`;
			return ctx.format.invalidInput(`${reason} Use list-wikis to see which wikis support it.`);
		}
		const refusal = await wikiGateRefusal(pack, toolName, wikiKey, ctx);
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

/**
 * Why a gated pack tool cannot run against this wiki, or undefined when it can.
 * Enforced here rather than in each handler: the tool stays offered while any
 * one wiki satisfies the gate, so every call to a wiki that does not has to be
 * refused — including from a pack that adds a gated tool later and does not
 * think to check.
 */
async function wikiGateRefusal(
	pack: ExtensionPack,
	toolName: string,
	wikiKey: string,
	ctx: ToolContext,
): Promise<string | undefined> {
	const gate = pack.wikiGate;
	if (gate === undefined || !gate.tools.includes(toolName)) {
		return undefined;
	}
	// The same cached siteinfo snapshot the extension check above read.
	if (gate.isSatisfied(await ctx.wikiProbe.inspect(wikiKey))) {
		return undefined;
	}
	return gate.refusal(wikiKey);
}
