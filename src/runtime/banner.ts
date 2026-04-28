import { createRequire } from 'node:module';
import { logger } from './logger.js';
import { classifyAuthShape } from '../transport/bearerGuard.js';
import { wikiRegistry, wikiSelection, uploadDirs } from '../wikis/state.js';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
const serverInfo = createRequire( import.meta.url )( '../../server.json' ) as {
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

export function emitStartupBanner( opts: CreateServerOptions ): void {
	const wikis = wikiRegistry.getAll();
	const data: Record<string, unknown> = {
		event: 'startup',
		version: serverInfo.version,
		transport: opts.transport,
		// eslint-disable-next-line camelcase
		auth_shape: classifyAuthShape( wikis, opts.transport ),
		// eslint-disable-next-line camelcase
		default_wiki: wikiSelection.getCurrent().key,
		wikis: Object.keys( wikis ),
		// eslint-disable-next-line camelcase
		allow_wiki_management: wikiRegistry.isManagementAllowed(),
		// eslint-disable-next-line camelcase
		upload_dirs_configured: uploadDirs.list().length > 0
	};
	if ( opts.transport === 'http' ) {
		data.host = opts.http.host;
		data.port = opts.http.port;
		if ( opts.http.allowedHosts !== undefined ) {
			// eslint-disable-next-line camelcase
			data.allowed_hosts = opts.http.allowedHosts;
		}
		if ( opts.http.allowedOrigins !== undefined ) {
			// eslint-disable-next-line camelcase
			data.allowed_origins = opts.http.allowedOrigins;
		}
		// eslint-disable-next-line camelcase
		data.max_request_body = opts.http.maxRequestBody;
	}
	logger.info( '', data );
}
