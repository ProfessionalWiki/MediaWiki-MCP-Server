import { createRequire } from 'node:module';

export const WIKI_RESOURCE_URI_PREFIX = 'mcp://wikis/';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- compile-time JSON import; ESM `import ... assert { type: 'json' }` migration is a separate follow-up
const serverInfo = createRequire(import.meta.url)('../../server.json') as {
	version: string;
	repository: { url: string };
};

const SERVER_NAME = 'mediawiki-mcp-server';

// Wikimedia's User-Agent policy wants a contact alongside the client name, and
// its API rate limits give a request without one the lowest tier.
export function resolveUserAgent(env: NodeJS.ProcessEnv): string {
	return (
		env.MCP_USER_AGENT?.trim() ||
		`${SERVER_NAME}/${serverInfo.version} (${serverInfo.repository.url})`
	);
}

export const USER_AGENT: string = resolveUserAgent(process.env);
