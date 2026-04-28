/* eslint-disable n/no-missing-import */
import { McpServer, type RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import { createRequire } from 'node:module';
import { logger, registerServer, unregisterServer } from './runtime/logger.js';
import { classifyAuthShape } from './transport/bearerGuard.js';
import { wikiRegistry, wikiSelection, uploadDirs } from './wikis/state.js';
import { registerAllTools } from './tools/index.js';
import { registerAllResources } from './resources/index.js';
import { reconcileTools } from './runtime/reconcile.js';
import type { ToolContext } from './runtime/context.js';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
const serverInfo = createRequire( import.meta.url )( '../server.json' ) as {
	title: string;
	description: string;
	version: string;
};

const SERVER_NAME: string = 'mediawiki-mcp-server';

const SERVER_INSTRUCTIONS: string = `Tools and resources for working with one or more MediaWiki wikis. Each configured wiki appears as an \`mcp://wikis/{wikiKey}\` resource. Tool calls target the currently selected wiki; pass an \`mcp://wikis/{wikiKey}\` URI to \`set-wiki\` to switch, and the selection persists until changed.

Writes, deletes, and uploads use the caller's \`Authorization: Bearer\` token when present, falling back to credentials configured on the active wiki.

Tool errors fall into seven categories: \`not_found\`, \`permission_denied\`, \`invalid_input\`, \`conflict\`, \`authentication\`, \`rate_limited\`, and \`upstream_failure\`. Reads that exceed a per-call cap return a truncation marker describing what was returned and how to fetch the rest.`;

export type CreateServerOptions =
	| { transport: 'stdio' }
	| {
		transport: 'http';
		http: {
			host: string;
			port: number;
			allowedHosts?: readonly string[];
			allowedOrigins?: readonly string[];
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
	}
	logger.info( '', data );
}

export const createServer = ( ctx: ToolContext, _opts?: CreateServerOptions ): McpServer => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			title: serverInfo.title,
			version: serverInfo.version,
			description: serverInfo.description
		},
		{
			capabilities: {
				resources: {
					listChanged: true
				},
				tools: {
					listChanged: true
				},
				logging: {}
			},
			instructions: SERVER_INSTRUCTIONS
		}
	);

	registerServer( server );
	// The SDK transport only fires onclose on DELETE / explicit transport.close()
	// / process termination — not on a raw HTTP disconnect. So this registry
	// drains on the same lifecycle as the existing sessions map in
	// streamableHttp.ts; long-lived stale sessions persist until DELETE arrives
	// or the process ends. Acceptable because sendLoggingMessage to a closed
	// transport rejects, and swallowNotificationError absorbs that quietly.
	const previousOnClose = server.server.onclose;
	server.server.onclose = (): void => {
		unregisterServer( server );
		previousOnClose?.();
	};

	const tools = new Map<string, RegisteredTool>();
	const reconcile = (): void => {
		reconcileTools( tools );
		// Notify clients that the wiki resource list may have changed (e.g. after
		// add-wiki / remove-wiki). Also covers tool-list changes since toggling a
		// RegisteredTool's enabled state already emits its own listChanged event.
		server.sendResourceListChanged();
	};

	const registered = registerAllTools( server, reconcile, ctx );
	for ( const [ name, tool ] of registered ) {
		tools.set( name, tool );
	}
	registerAllResources( server, ctx );

	reconcile();

	return server;
};
