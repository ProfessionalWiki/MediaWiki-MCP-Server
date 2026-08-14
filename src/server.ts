import { McpServer } from '@modelcontextprotocol/server';
import type { RegisteredTool } from '@modelcontextprotocol/server';
import { createRequire } from 'node:module';
import { registerAllTools } from './tools/index.ts';
import { registerAllResources } from './resources/index.ts';
import { reconcileTools } from './runtime/reconcile.ts';
import { extensionPacks } from './tools/extensions/index.ts';
import type { ToolContext } from './runtime/context.ts';

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- compile-time JSON import; ESM `import ... assert { type: 'json' }` migration is a separate follow-up
const serverInfo = createRequire(import.meta.url)('../server.json') as {
	title: string;
	description: string;
	version: string;
};

const SERVER_NAME: string = 'mediawiki-mcp-server';

const SERVER_INSTRUCTIONS: string = `Tools and resources for working with one or more MediaWiki wikis. Each configured wiki appears as an \`mcp://wikis/{wikiKey}\` resource. Every tool that operates on a wiki accepts an optional \`wiki\` argument naming the wiki to act on (the wiki-management and OAuth tools do not) — pass a wiki key (or its \`mcp://wikis/{wikiKey}\` URI). Omit it to use the configured default wiki. There is no stateful "current wiki": each call targets exactly the wiki it names, and every response reports the wiki it ran against. Call \`list-wikis\` to discover the configured wikis, their keys, and which extension tools each one supports.

Writes, deletes, and uploads act as whichever identity the deployment provides: the signed-in user when hosted OAuth sign-in is configured, otherwise the credentials configured on the targeted wiki. Over HTTP a caller holding a MediaWiki bot password may instead send \`Authorization: Basic <base64 of "username:password">\` and act as that user for the request. Do not send an \`Authorization: Bearer\` token of your own unless the deployment asked you to; one is refused rather than used.

Tool errors fall into seven categories: \`not_found\`, \`permission_denied\`, \`invalid_input\`, \`conflict\`, \`authentication\`, \`rate_limited\`, and \`upstream_failure\`. Reads that exceed a per-call cap return a truncation marker describing what was returned and how to fetch the rest.`;

// How a transport hands change events to clients that cannot receive them as
// unsolicited pushes. The stdio entry rewrites a live connection's outbound
// change notifications onto its subscriptions/listen streams, so the default
// publisher below covers both stdio eras; the HTTP transport supplies one
// backed by its handler's notify facade instead, because a per-request
// instance has no client left to push to by the time anything changes.
export interface ChangePublisher {
	toolsChanged(): void;
	resourcesChanged(): void;
}

export interface CreateServerOptions {
	publisher?: ChangePublisher;
}

// Everything cacheable here changes only when a reconcile pass runs (a wiki is
// added or removed, or an extension probe flips), and subscribed clients learn
// of that through listChanged events — the TTL only bounds staleness for
// clients that poll instead. Private scope: tool and resource lists reflect
// this deployment's wiki configuration, so a shared cache must not serve one
// deployment's lists to another behind the same intermediary.
const CACHE_HINT = { ttlMs: 60_000, cacheScope: 'private' } as const;

export const createServer = async (
	ctx: ToolContext,
	options: CreateServerOptions = {},
): Promise<McpServer> => {
	const server = new McpServer(
		{
			name: SERVER_NAME,
			title: serverInfo.title,
			version: serverInfo.version,
			description: serverInfo.description,
		},
		{
			capabilities: {
				resources: {
					listChanged: true,
				},
				tools: {
					listChanged: true,
				},
			},
			instructions: SERVER_INSTRUCTIONS,
			cacheHints: {
				'tools/list': CACHE_HINT,
				'resources/list': CACHE_HINT,
				'resources/templates/list': CACHE_HINT,
				'resources/read': CACHE_HINT,
				'server/discover': CACHE_HINT,
			},
		},
	);

	const publisher: ChangePublisher = options.publisher ?? {
		// A live connection's RegisteredTool toggles already emit their own
		// listChanged; only the resource list needs an explicit push.
		toolsChanged: (): void => {},
		resourcesChanged: (): void => {
			server.sendResourceListChanged();
		},
	};

	const tools = new Map<string, RegisteredTool>();
	const applyGates = (): Promise<void> =>
		reconcileTools(tools, {
			wikiRegistry: ctx.wikis,
			transport: ctx.transport,
			wikiProbe: ctx.wikiProbe,
			extensionPacks,
		});
	// The reconcile callback add-wiki / remove-wiki invoke: re-gate, then tell
	// clients the wiki resource list (and with it the tool list) may have
	// changed.
	const reconcile = async (): Promise<void> => {
		await applyGates();
		publisher.resourcesChanged();
		publisher.toolsChanged();
	};

	const registered = registerAllTools(server, reconcile, ctx);
	for (const [name, tool] of registered) {
		tools.set(name, tool);
	}
	registerAllResources(server, ctx);

	// Construction gates without publishing: a fresh instance has no
	// subscribers yet, and under a per-request factory a construction-time
	// publish would fan change events out to unrelated clients on every
	// request.
	await applyGates();

	return server;
};
