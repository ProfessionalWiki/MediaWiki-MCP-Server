import type { ActiveWiki } from './activeWiki.js';

export function getPageUrl(title: string, activeWiki: ActiveWiki): string {
	const { server, articlepath } = activeWiki.get().config;
	// MediaWiki convention: spaces become underscores. encodeURI preserves
	// '/' (subpages) and ':' (namespace prefixes) while encoding spaces and
	// non-ASCII characters. Characters disallowed in MW titles ('#', '?',
	// '|', '[', ']', etc.) cannot reach this function via a real page title.
	return `${server}${articlepath}/${encodeURI(title.replace(/ /g, '_'))}`;
}

export function formatEditComment(tool: string, comment?: string): string {
	const suffix = `(via ${tool} on MediaWiki MCP Server)`;
	if (!comment) {
		return `Automated edit ${suffix}`;
	}
	return `${comment} ${suffix}`;
}
