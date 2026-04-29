import { createRequire } from 'node:module';
import { logger } from './logger.js';
import { classifyAuthShape } from '../transport/bearerGuard.js';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import type { WikiSelection } from '../wikis/wikiSelection.js';
import type { UploadDirs } from '../wikis/uploadDirs.js';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- compile-time JSON import; ESM `import ... assert { type: 'json' }` migration is a separate follow-up
const serverInfo = createRequire(import.meta.url)('../../server.json') as {
	title: string;
	description: string;
	version: string;
};

export type CreateServerOptions =
	| { transport: 'stdio' }
	| {
			transport: 'http';
			http: {
				host: string;
				port: number;
				allowedHosts?: readonly string[];
				allowedOrigins?: readonly string[];
				maxRequestBody: string;
			};
	  };

export interface BannerDeps {
	readonly wikiRegistry: WikiRegistry;
	readonly wikiSelection: WikiSelection;
	readonly uploadDirs: UploadDirs;
}

export function emitStartupBanner(opts: CreateServerOptions, deps: BannerDeps): void {
	const wikis = deps.wikiRegistry.getAll();
	const data: Record<string, unknown> = {
		event: 'startup',
		version: serverInfo.version,
		transport: opts.transport,
		auth_shape: classifyAuthShape(wikis, opts.transport),
		default_wiki: deps.wikiSelection.getCurrent().key,
		wikis: Object.keys(wikis),
		allow_wiki_management: deps.wikiRegistry.isManagementAllowed(),
		upload_dirs_configured: deps.uploadDirs.list().length > 0,
	};
	if (opts.transport === 'http') {
		data.host = opts.http.host;
		data.port = opts.http.port;
		if (opts.http.allowedHosts !== undefined) {
			data.allowed_hosts = opts.http.allowedHosts;
		}
		if (opts.http.allowedOrigins !== undefined) {
			data.allowed_origins = opts.http.allowedOrigins;
		}
		data.max_request_body = opts.http.maxRequestBody;
	}
	logger.info('', data);
}
