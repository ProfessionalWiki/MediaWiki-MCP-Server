import { createRequire } from 'node:module';

export const WIKI_RESOURCE_URI_PREFIX = 'mcp://wikis/';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- compile-time JSON import; ESM `import ... assert { type: 'json' }` migration is a separate follow-up
const serverInfo = createRequire(import.meta.url)('../../server.json') as {
	version: string;
};

const SERVER_NAME = 'mediawiki-mcp-server';

export const USER_AGENT: string = `${SERVER_NAME}/${serverInfo.version}`;
