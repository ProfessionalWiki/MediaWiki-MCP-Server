import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { ToolContext } from './context.js';
import type { ExtensionPack } from '../tools/extensions/types.js';
import { extensionPacks } from '../tools/extensions/index.js';
import { getRuntimeToken } from '../transport/requestContext.js';
import { hasStaticCredentials } from '../transport/bearerGuard.js';

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
	// fail downstream with an opaque error. Reject it up front with discovery
	// guidance. (On stdio the dispatcher's acquireToken gate drives OAuth, so
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
				return ctx.format.error(
					'authentication',
					`Wiki "${wikiKey}" requires OAuth authentication. ` +
						"Send an Authorization: Bearer token for this wiki; see the server's " +
						"/.well-known/oauth-protected-resource document for the wiki's " +
						'authorization server.',
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
	}
	if (WRITE_TOOL_SET.has(toolName)) {
		const config = ctx.wikis.get(wikiKey);
		if (config?.readOnly === true) {
			return ctx.format.permissionDenied(`Wiki "${wikiKey}" is configured read-only.`);
		}
	}
	return undefined;
}
