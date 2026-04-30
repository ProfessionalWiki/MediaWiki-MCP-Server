// tests/helpers/fakeAuthorizationServer.ts
import express from 'express';
import type { Express, RequestHandler } from 'express';
import { type Server } from 'node:http';
import { type AddressInfo } from 'node:net';

export interface FakeAsOptions {
	wellKnown?: 'origin' | 'pathed' | 'absent';
	wellKnownBody?: Record<string, unknown>;
	authorize?: RequestHandler;
	token?: RequestHandler;
}

export interface FakeAsHandle {
	readonly url: string;
	readonly app: Express;
	close(): Promise<void>;
}

export async function startFakeAs(opts: FakeAsOptions = {}): Promise<FakeAsHandle> {
	const app = express();
	app.use(express.urlencoded({ extended: false }));
	app.use(express.json());

	const defaultBody = {
		issuer: '__SELF__',
		authorization_endpoint: '__SELF__/w/rest.php/oauth2/authorize',
		token_endpoint: '__SELF__/w/rest.php/oauth2/access_token',
		code_challenge_methods_supported: ['S256'],
		grant_types_supported: ['authorization_code', 'refresh_token'],
		response_types_supported: ['code'],
		scopes_supported: ['mwoauth-authonly', 'edit'],
	};

	const body = (handle: FakeAsHandle): Record<string, unknown> => {
		const merged = { ...defaultBody, ...(opts.wellKnownBody ?? {}) };
		// Substitute __SELF__ with the live URL so cross-origin assertions work.
		return Object.fromEntries(
			Object.entries(merged).map(([k, v]) => [
				k,
				typeof v === 'string' ? v.replace(/__SELF__/g, handle.url) : v,
			]),
		);
	};

	let server: Server | undefined;
	const handle: FakeAsHandle = {
		url: '',
		app,
		async close() {
			await new Promise<void>((resolve) => server?.close(() => resolve()));
		},
	};

	if (opts.wellKnown === 'origin' || opts.wellKnown === undefined) {
		app.get('/.well-known/oauth-authorization-server', (_req, res) => {
			res.json(body(handle));
		});
	} else if (opts.wellKnown === 'pathed') {
		app.get('/.well-known/oauth-authorization-server/w/rest.php/oauth2', (_req, res) => {
			res.json(body(handle));
		});
	}
	// 'absent': don't register either route.

	app.post('/w/rest.php/oauth2/access_token', opts.token ?? defaultTokenHandler);
	app.get('/w/rest.php/oauth2/authorize', opts.authorize ?? ((_req, res) => res.status(404).end()));

	server = await new Promise<Server>((resolve) => {
		const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
	});
	const port = (server.address() as AddressInfo).port;
	(handle as { url: string }).url = `http://127.0.0.1:${port}`;
	return handle;
}

function defaultTokenHandler(req: express.Request, res: express.Response): void {
	const grant = String(req.body.grant_type ?? '');
	if (grant === 'authorization_code') {
		res.json({
			access_token: 'access-' + String(req.body.code),
			refresh_token: 'refresh-' + String(req.body.code),
			expires_in: 3600,
			scope: 'edit',
			token_type: 'Bearer',
		});
		return;
	}
	if (grant === 'refresh_token') {
		res.json({
			access_token: 'access-refreshed',
			refresh_token: 'refresh-rotated',
			expires_in: 3600,
			scope: 'edit',
			token_type: 'Bearer',
		});
		return;
	}
	res.status(400).json({ error: 'unsupported_grant_type' });
}
