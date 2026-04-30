// src/auth/browserAuth.ts
import * as http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import open from 'open';
import { logger } from '../runtime/logger.js';
import { fetchMetadata } from './metadata.js';
import type { WikiSlice } from './metadata.js';
import { randomVerifier, s256 } from './pkce.js';
import { exchangeCode, OAuthFlowError } from './oauthFlow.js';
import { createTokenStore } from './tokenStore.js';

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class BrowserAuthError extends Error {
	constructor(
		public readonly reason:
			| 'user_denied'
			| 'timeout'
			| 'state_mismatch'
			| 'invalid_client'
			| 'invalid_grant'
			| 'transient',
		message: string,
	) {
		super(message);
		this.name = 'BrowserAuthError';
	}
}

export interface BrowserAuthCtx {
	wiki: WikiSlice;
	clientId: string;
	scopes?: string[];
	timeoutMs?: number;
}

const inFlight = new Map<string, Promise<string>>();

export function _resetBrowserAuthDedupForTesting(): void {
	inFlight.clear();
}

export function browserAuth(wikiKey: string, ctx: BrowserAuthCtx): Promise<string> {
	const existing = inFlight.get(wikiKey);
	if (existing !== undefined) {
		return existing;
	}

	const pending = doBrowserAuth(wikiKey, ctx).finally(() => {
		inFlight.delete(wikiKey);
	});
	inFlight.set(wikiKey, pending);
	return pending;
}

async function doBrowserAuth(wikiKey: string, ctx: BrowserAuthCtx): Promise<string> {
	const started = Date.now();
	const timeoutMs = ctx.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	const metadata = await fetchMetadata(wikiKey, ctx.wiki);

	const verifier = randomVerifier();
	const challenge = s256(verifier);
	const state = randomBytes(32).toString('hex');

	// Spin up loopback listener on OS-assigned port
	const { server, port } = await startListener();
	const redirectUri = `http://127.0.0.1:${port}/oauth/callback`;

	// Build authorization URL
	const authUrl = buildAuthUrl(
		metadata.authorization_endpoint,
		ctx.clientId,
		redirectUri,
		challenge,
		state,
		ctx.scopes,
	);

	logger.info('', { event: 'oauth_login_started', wiki: wikiKey, port });

	// Attach callback listener before opening the browser so the request
	// handler is registered when the browser redirects back.
	const callbackPromise = waitForCallback(server, state);

	// Arm the timeout. Silence unhandled-rejection warnings on both race
	// participants before any await — the winning promise propagates its
	// outcome via Promise.race; the loser is intentionally discarded.
	const timeoutHandle = timeout(timeoutMs);
	callbackPromise.catch(() => undefined);
	timeoutHandle.promise.catch(() => undefined);

	// Attempt to open browser
	if (process.env.MCP_OAUTH_NO_BROWSER === '1') {
		process.stderr.write(`[mediawiki-mcp] Open this URL to log in: ${authUrl}\n`);
	} else {
		try {
			await open(authUrl);
		} catch {
			process.stderr.write(
				`[mediawiki-mcp] Could not open browser. Open this URL to log in: ${authUrl}\n`,
			);
		}
	}

	let code: string;
	try {
		code = await Promise.race([callbackPromise, timeoutHandle.promise]);
	} finally {
		// Cancel the timeout so the process doesn't keep a 5-minute timer
		// alive after a successful (or failed) dance.
		timeoutHandle.cancel();
		server.close();
	}

	// Exchange code for token
	let tok: Awaited<ReturnType<typeof exchangeCode>>;
	try {
		tok = await exchangeCode({
			tokenEndpoint: metadata.token_endpoint,
			code,
			verifier,
			clientId: ctx.clientId,
			redirectUri,
		});
	} catch (err: unknown) {
		const reason = mapFlowErrorReason(err);
		logger.info('', {
			event: 'oauth_login_failed',
			wiki: wikiKey,
			reason,
			duration_ms: Date.now() - started,
		});
		if (err instanceof OAuthFlowError) {
			throw new BrowserAuthError(reason, err.message);
		}
		throw err;
	}

	// Persist token
	const nowMs = Date.now();
	const nowIso = new Date(nowMs).toISOString();
	const expiresAtIso = new Date(nowMs + tok.expires_in * 1000).toISOString();
	const scopes = tok.scope !== undefined ? tok.scope.split(' ') : (ctx.scopes ?? []);

	const store = createTokenStore();
	await store.put(wikiKey, {
		access_token: tok.access_token,
		refresh_token: tok.refresh_token,
		expires_at: expiresAtIso,
		scopes,
		obtained_at: nowIso,
	});

	logger.info('', {
		event: 'oauth_login_completed',
		wiki: wikiKey,
		duration_ms: Date.now() - started,
	});

	return tok.access_token;
}

function buildAuthUrl(
	authorizationEndpoint: string,
	clientId: string,
	redirectUri: string,
	challenge: string,
	state: string,
	scopes?: string[],
): string {
	const u = new URL(authorizationEndpoint);
	u.searchParams.set('response_type', 'code');
	u.searchParams.set('client_id', clientId);
	u.searchParams.set('redirect_uri', redirectUri);
	u.searchParams.set('code_challenge', challenge);
	u.searchParams.set('code_challenge_method', 'S256');
	u.searchParams.set('state', state);
	if (scopes !== undefined && scopes.length > 0) {
		u.searchParams.set('scope', scopes.join(' '));
	}
	return u.toString();
}

interface ListenerResult {
	server: http.Server;
	port: number;
}

function startListener(): Promise<ListenerResult> {
	return new Promise((resolve, reject) => {
		const server = http.createServer();
		server.listen(0, '127.0.0.1', () => {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- server.address() is AddressInfo when the server is bound to a TCP port
			const addr = server.address() as AddressInfo;
			resolve({ server, port: addr.port });
		});
		server.on('error', reject);
	});
}

function waitForCallback(server: http.Server, expectedState: string): Promise<string> {
	return new Promise<string>((resolve, reject) => {
		server.on('request', (req, res) => {
			const url = new URL(req.url ?? '/', `http://127.0.0.1`);

			if (url.pathname !== '/oauth/callback') {
				res.writeHead(404).end('Not found');
				return;
			}

			const error = url.searchParams.get('error');
			if (error === 'access_denied') {
				res
					.writeHead(200, { 'Content-Type': 'text/html' })
					.end('<html><body><h1>Login cancelled</h1><p>You can close this tab.</p></body></html>');
				reject(new BrowserAuthError('user_denied', 'User denied the authorization request'));
				return;
			}

			const returnedState = url.searchParams.get('state');
			if (!returnedState || returnedState !== expectedState) {
				res
					.writeHead(400, { 'Content-Type': 'text/html' })
					.end('<html><body><h1>Possible CSRF; please retry.</h1></body></html>');
				reject(new BrowserAuthError('state_mismatch', 'State parameter mismatch — possible CSRF'));
				return;
			}

			const code = url.searchParams.get('code');
			if (!code) {
				res
					.writeHead(400, { 'Content-Type': 'text/html' })
					.end('<html><body><h1>Missing code parameter</h1></body></html>');
				reject(new BrowserAuthError('transient', 'Missing code parameter in callback'));
				return;
			}

			res
				.writeHead(200, { 'Content-Type': 'text/html' })
				.end(
					'<html><body><h1>Login successful</h1><p>You can close this tab and return to your terminal.</p></body></html>',
				);
			resolve(code);
		});
	});
}

interface TimeoutHandle {
	promise: Promise<never>;
	cancel: () => void;
}

function timeout(ms: number): TimeoutHandle {
	let timer: ReturnType<typeof setTimeout> | undefined;
	const promise = new Promise<never>((_, reject) => {
		timer = setTimeout(() => {
			reject(new BrowserAuthError('timeout', `No callback received within ${ms}ms`));
		}, ms);
	});
	return {
		promise,
		cancel(): void {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		},
	};
}

function mapFlowErrorReason(err: unknown): BrowserAuthError['reason'] {
	if (err instanceof OAuthFlowError) {
		if (err.kind === 'invalid_client' || err.kind === 'invalid_grant' || err.kind === 'transient') {
			return err.kind;
		}
		return 'transient';
	}
	return 'transient';
}
