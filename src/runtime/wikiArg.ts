import { z } from 'zod';
import type { ZodRawShape } from 'zod';
import { WIKI_RESOURCE_URI_PREFIX } from './constants.js';

export const WIKI_ARG_DESCRIPTION =
	'Wiki to target, as a key from the mcp://wikis/ resources (e.g. en.wikipedia.org), ' +
	'or the full mcp://wikis/ URI. Omit to use the default wiki.';

export const wikiArgSchema = z.string().optional().describe(WIKI_ARG_DESCRIPTION);

// Accepts a bare registry key or a full mcp://wikis/{key} resource URI.
export function normalizeWikiArg(value: string): string {
	const trimmed = value.trim();
	return trimmed.startsWith(WIKI_RESOURCE_URI_PREFIX)
		? trimmed.slice(WIKI_RESOURCE_URI_PREFIX.length).trim()
		: trimmed;
}

export function isWikiScoped(tool: { wikiScoped?: boolean }): boolean {
	return tool.wikiScoped !== false;
}

// Returns the schema a tool should be registered with: wiki-scoped tools get
// the shared `wiki` field merged in; others are returned unchanged. Only the
// `inputSchema`/`wikiScoped` slice of the descriptor is needed, so the
// parameter is narrowed to avoid the generic-variance issues of `Tool<...>`.
export function buildToolInputSchema(tool: {
	readonly inputSchema: ZodRawShape;
	readonly wikiScoped?: boolean;
}): ZodRawShape {
	if (!isWikiScoped(tool)) {
		return tool.inputSchema;
	}
	return { ...tool.inputSchema, wiki: wikiArgSchema };
}
