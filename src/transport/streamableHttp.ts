#!/usr/bin/env node

import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import express, {
	type ErrorRequestHandler,
	type RequestHandler,
	type Request,
	type Response,
} from 'express';
import {
	hostHeaderValidation,
	localhostHostValidation,
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { evaluateBearerGuard } from './bearerGuard.js';
import { LOCALHOST_HOSTS, resolveHttpConfig } from './httpConfig.js';
import { logger } from '../runtime/logger.js';
import {
	getMetricsHandler,
	initMetrics,
	isMetricsEnabled,
	recordReadyFailure,
	setSessionsProvider,
} from '../runtime/metrics.js';
import { runtimeTokenStore } from './requestContext.js';
import { loadConfigFromFile } from '../config/loadConfig.js';
import { createAppState } from '../wikis/state.js';
import { createServer } from '../server.js';
import { emitStartupBanner } from '../runtime/banner.js';
import { createToolContext } from '../runtime/createContext.js';
import { registerShutdownHandlers, resolveShutdownGrace } from '../runtime/shutdown.js';

export async function withRequestContext<T>(
	runtimeToken: string | undefined,
	sessionId: string | undefined,
	fn: () => Promise<T>,
): Promise<T> {
	return runtimeTokenStore.run({ runtimeToken, sessionId }, fn);
}

export function extractBearerToken(req: Request): string | undefined {
	const raw = req.headers.authorization;
	if (typeof raw !== 'string') {
		return undefined;
	}
	const first = raw.split(',')[0].trim();
	if (!first.toLowerCase().startsWith('bearer ')) {
		return undefined;
	}
	const token = first.slice(7).trim();
	return token || undefined;
}

// Separate from any token value so "no bearer" and "empty string" cannot collide.
const NO_BEARER_SENTINEL = ' no-bearer';

export function hashBearer(token: string | undefined): string {
	const input = token === undefined ? NO_BEARER_SENTINEL : `t:${token}`;
	return createHash('sha256').update(input).digest('hex');
}

export function verifySessionBearer(storedHash: string, token: string | undefined): boolean {
	// Buffer.from(..., 'hex') silently drops non-hex characters and
	// truncates on odd length, so malformed input yields a short or
	// empty buffer rather than throwing — the length check below
	// rejects it before timingSafeEqual runs.
	const a = Buffer.from(storedHash, 'hex');
	const b = Buffer.from(hashBearer(token), 'hex');
	if (a.length === 0 || a.length !== b.length) {
		return false;
	}
	return timingSafeEqual(a, b);
}

export function resolveMcpHostValidation(
	host: string,
	allowedHosts: string[] | undefined,
): RequestHandler | undefined {
	if (allowedHosts) {
		return hostHeaderValidation(allowedHosts);
	}
	if (LOCALHOST_HOSTS.includes(host)) {
		return localhostHostValidation();
	}
	if (host === '0.0.0.0' || host === '::') {
		logger.warning(
			`Server is binding to ${host} without a Host-header allowlist. ` +
				'Set MCP_ALLOWED_HOSTS to restrict allowed Host-header values, ' +
				'or use authentication to protect your server.',
		);
	}
	return undefined;
}

export type SessionEntry = {
	readonly transport: StreamableHTTPServerTransport;
	readonly bearerHash: string;
};

export type SessionRegistry = { [sessionId: string]: SessionEntry };

export interface InFlightCounter {
	readonly middleware: RequestHandler;
	readonly count: () => number;
}

export function createInFlightCounter(): InFlightCounter {
	let n = 0;
	const middleware: RequestHandler = (_req, res, next) => {
		n++;
		res.on('close', () => {
			n--;
		});
		next();
	};
	return { middleware, count: () => n };
}

function sendSessionBearerMismatch(res: Response): void {
	res.status(401).json({
		jsonrpc: '2.0',
		error: {
			code: -32001,
			message:
				'Unauthorized: session bearer does not match the token that initialized this session',
		},
		id: null,
	});
}

export interface McpPostHandlerOptions {
	allowedOrigins?: string[];
}

export function createMcpPostHandler(
	sessions: SessionRegistry,
	createServerFn: () => ReturnType<typeof createServer>,
	options: McpPostHandlerOptions = {},
): RequestHandler {
	const { allowedOrigins } = options;
	return async (req, res) => {
		const sessionId = req.headers['mcp-session-id'] as string | undefined;
		const bearer = extractBearerToken(req);
		let transport: StreamableHTTPServerTransport;

		if (sessionId && sessions[sessionId]) {
			const entry = sessions[sessionId];
			if (!verifySessionBearer(entry.bearerHash, bearer)) {
				sendSessionBearerMismatch(res);
				return;
			}
			transport = entry.transport;
		} else if (!sessionId && isInitializeRequest(req.body)) {
			const initialBearerHash = hashBearer(bearer);
			transport = new StreamableHTTPServerTransport({
				sessionIdGenerator: () => randomUUID(),
				// The SDK transport's Origin check is gated behind this flag.
				// Host-header validation stays in Express middleware upstream, so
				// we don't pass allowedHosts here (that inner check no-ops when
				// _allowedHosts is undefined, regardless of the flag).
				enableDnsRebindingProtection: allowedOrigins !== undefined,
				allowedOrigins,
				onsessioninitialized: (newSessionId) => {
					sessions[newSessionId] = { transport, bearerHash: initialBearerHash };
				},
			});

			transport.onclose = () => {
				if (transport.sessionId) {
					delete sessions[transport.sessionId];
				}
			};
			const server = createServerFn();

			await server.connect(transport);
		} else {
			res.status(400).json({
				jsonrpc: '2.0',
				error: {
					code: -32000,
					message: 'Bad Request: No valid session ID provided',
				},
				id: null,
			});
			return;
		}

		await withRequestContext(bearer, transport.sessionId, () =>
			transport.handleRequest(req, res, req.body),
		);
	};
}

export function createSessionRequestHandler(sessions: SessionRegistry): RequestHandler {
	return async (req, res) => {
		const sessionId = req.headers['mcp-session-id'] as string | undefined;
		if (!sessionId || !sessions[sessionId]) {
			res.status(400).send('Invalid or missing session ID');
			return;
		}

		const entry = sessions[sessionId];
		const bearer = extractBearerToken(req);
		if (!verifySessionBearer(entry.bearerHash, bearer)) {
			sendSessionBearerMismatch(res);
			return;
		}
		await withRequestContext(bearer, sessionId, () => entry.transport.handleRequest(req, res));
	};
}

// body-parser raises a PayloadTooLargeError with `type === 'entity.too.large'`
// when the request body exceeds the configured limit. Without this handler the
// default Express error page returns an HTML blob, which an MCP client cannot
// parse — so we shape it as a JSON-RPC error.
export function payloadTooLargeHandler(limit: string): ErrorRequestHandler {
	return (err, _req, res, next) => {
		const tooLarge =
			typeof err === 'object' &&
			err !== null &&
			(err as { type?: unknown }).type === 'entity.too.large';
		if (!tooLarge) {
			next(err);
			return;
		}
		res.status(413).json({
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: `Request body exceeds the configured maximum size of ${limit}`,
			},
			id: null,
		});
	};
}

interface ReadyCacheEntry {
	expiresAt: number;
	payload: { status: 'ready' | 'not_ready'; wiki: string; reason?: string; checked_at: string };
	httpStatus: 200 | 503;
}

const READY_CACHE_TTL_MS = 5_000;
const READY_PROBE_TIMEOUT_MS = 3_000;
let readyCache: ReadyCacheEntry | null = null;

export function __resetReadyCacheForTesting(): void {
	readyCache = null;
}

async function probeDefaultWiki(
	wikiSelection: import('../wikis/wikiSelection.js').WikiSelection,
	mwnProvider: import('../wikis/mwnProvider.js').MwnProvider,
): Promise<ReadyCacheEntry> {
	const wiki = wikiSelection.getCurrent().key;
	const checkedAt = new Date().toISOString();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const timeout = new Promise<never>((_, reject) => {
		timer = setTimeout(
			() => reject(new Error('probe timeout after 3000ms')),
			READY_PROBE_TIMEOUT_MS,
		);
	});

	try {
		const mwn = await mwnProvider.get();
		await Promise.race([
			mwn.request({
				action: 'query',
				meta: 'siteinfo',
				format: 'json',
				siprop: 'general',
			}),
			timeout,
		]);
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'ready', wiki, checked_at: checkedAt },
			httpStatus: 200,
		};
	} catch (err) {
		const reason = err instanceof Error ? err.message : String(err);
		return {
			expiresAt: Date.now() + READY_CACHE_TTL_MS,
			payload: { status: 'not_ready', wiki, reason, checked_at: checkedAt },
			httpStatus: 503,
		};
	} finally {
		if (timer) {
			clearTimeout(timer);
		}
	}
}

export const __probeDefaultWikiForTesting = probeDefaultWiki;

export function mountMetricsEndpoint(app: express.Express): void {
	if (!isMetricsEnabled()) {
		return;
	}
	initMetrics();
	const handler = getMetricsHandler();
	if (handler) {
		app.get('/metrics', handler);
	}
}

export function mountReadyEndpoint(
	app: express.Express,
	deps: {
		wikiSelection: import('../wikis/wikiSelection.js').WikiSelection;
		mwnProvider: import('../wikis/mwnProvider.js').MwnProvider;
	},
): void {
	app.get('/ready', async (_req, res) => {
		if (!readyCache || Date.now() >= readyCache.expiresAt) {
			readyCache = await probeDefaultWiki(deps.wikiSelection, deps.mwnProvider);
			if (readyCache.httpStatus !== 200) {
				recordReadyFailure();
			}
		}
		res.status(readyCache.httpStatus).json(readyCache.payload);
	});
}

const config = loadConfigFromFile();
const state = createAppState(config);
const { host, port, allowedHosts, allowedOrigins, maxRequestBody, warnings } = resolveHttpConfig();
const guard = evaluateBearerGuard(state.wikiRegistry.getAll(), process.env);
if (guard.kind === 'block') {
	logger.error(
		'HTTP transport refuses to start because static credentials are configured for wiki(s): ' +
			guard.wikis.join(', ') +
			'.\n' +
			'A request without an Authorization header would silently act as the configured identity, ' +
			'defeating per-caller bearer passthrough.\n' +
			'Remove `token`, `username`, and `password` from these wikis in config.json, ' +
			'or set MCP_ALLOW_STATIC_FALLBACK=true to acknowledge the shared-identity deployment shape.',
	);
	process.exit(1);
}
if (guard.kind === 'override') {
	logger.warning(
		'MCP_ALLOW_STATIC_FALLBACK=true is set. Wiki(s) with static credentials: ' +
			guard.wikis.join(', ') +
			'. ' +
			'Requests without an Authorization header will act as the configured identity. ' +
			'This deployment cannot attribute writes to individual callers.',
	);
}
for (const warning of warnings) {
	logger.warning(warning);
}
emitStartupBanner(
	{ transport: 'http', http: { host, port, allowedHosts, allowedOrigins, maxRequestBody } },
	{
		wikiRegistry: state.wikiRegistry,
		wikiSelection: state.wikiSelection,
		uploadDirs: state.uploadDirs,
	},
);

const app = express();
app.use(express.json({ limit: maxRequestBody }));
app.use(payloadTooLargeHandler(maxRequestBody));

const hostValidation = resolveMcpHostValidation(host, allowedHosts);
if (hostValidation) {
	app.use('/mcp', hostValidation);
}

if ((host === '0.0.0.0' || host === '::') && !allowedOrigins) {
	logger.warning(
		`Server is binding to ${host} without an Origin allowlist. ` +
			'Set MCP_ALLOWED_ORIGINS to restrict allowed Origin-header values, ' +
			'or front the server with a reverse proxy that enforces Origin.',
	);
}

const sessions: SessionRegistry = {};
const sessionRequestHandler = createSessionRequestHandler(sessions);
const ctx = createToolContext({ logger, state });

const inFlight = createInFlightCounter();
app.use('/mcp', inFlight.middleware);

app.post(
	'/mcp',
	createMcpPostHandler(sessions, () => createServer(ctx), { allowedOrigins }),
);
app.get('/mcp', sessionRequestHandler);
app.delete('/mcp', sessionRequestHandler);

app.get('/health', (_req: Request, res: Response) => {
	res.status(200).json({ status: 'ok' });
});

mountReadyEndpoint(app, { wikiSelection: state.wikiSelection, mwnProvider: state.mwnProvider });
mountMetricsEndpoint(app);
setSessionsProvider(() => Object.keys(sessions).length);

const httpServer = app.listen(port, host, () => {
	logger.info(`MCP Streamable HTTP Server listening on ${host}:${port}`);
});

registerShutdownHandlers({
	transport: 'http',
	graceMs: resolveShutdownGrace(process.env),
	httpServer,
	sessions,
	inFlight,
});
