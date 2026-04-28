import { createRequire } from 'node:module';

export const WIKI_RESOURCE_URI_PREFIX = 'mcp://wikis/';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
const serverInfo = createRequire(import.meta.url)('../../server.json') as {
	version: string;
};

const SERVER_NAME = 'mediawiki-mcp-server';

export const USER_AGENT: string = `${SERVER_NAME}/${serverInfo.version}`;
