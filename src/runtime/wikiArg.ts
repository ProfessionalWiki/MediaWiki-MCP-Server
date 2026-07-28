import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { WIKI_RESOURCE_URI_PREFIX } from './constants.js';
import { decodeWikiKey } from './wikiKey.js';

export const WIKI_ARG_DESCRIPTION =
	'Wiki to target, as a key from the mcp://wikis/ resources (e.g. en.wikipedia.org), ' +
	'or the full mcp://wikis/ URI. Omit to use the default wiki.';

export const wikiArgSchema = z.string().optional().describe(WIKI_ARG_DESCRIPTION);

// Accepts a bare registry key or a full mcp://wikis/{key} resource URI. The URI
// form carries the key percent-encoded, so it is decoded back to the registry
// spelling. A segment that is not valid percent-encoding is taken literally,
// which is more forgiving than the resource read path: that answers -32602,
// while a `wiki` argument spelled "mcp://wikis/100%" still finds the "100%"
// wiki. Being lenient about an argument the caller typed costs nothing, whereas
// a resource URI is something this server published and can be held to.
export function normalizeWikiArg(value: string): string {
	const trimmed = value.trim();
	if (!trimmed.startsWith(WIKI_RESOURCE_URI_PREFIX)) {
		return trimmed;
	}
	const segment = trimmed.slice(WIKI_RESOURCE_URI_PREFIX.length).trim();
	return decodeWikiKey(segment) ?? segment;
}

export function isWikiScoped(tool: { wikiScoped?: boolean }): boolean {
	return tool.wikiScoped !== false;
}

// Returns the schema a tool should be registered with: wiki-scoped tools get
// the shared `wiki` field merged in; others are wrapped as-is. Only the
// `inputSchema`/`wikiScoped` slice of the descriptor is needed, so the
// parameter is narrowed to avoid the generic-variance issues of `Tool<...>`.
//
// Descriptors declare `inputSchema` as a raw shape, but `registerTool` takes a
// Standard Schema object, so the `z.object()` wrap happens here — the one place
// every tool's shape passes through on its way to registration.
export function buildToolInputSchema(tool: {
	readonly inputSchema: ZodRawShape;
	readonly wikiScoped?: boolean;
}): z.ZodObject<ZodRawShape> {
	if (!isWikiScoped(tool)) {
		return z.object(tool.inputSchema);
	}
	return z.object({ ...tool.inputSchema, wiki: wikiArgSchema });
}
