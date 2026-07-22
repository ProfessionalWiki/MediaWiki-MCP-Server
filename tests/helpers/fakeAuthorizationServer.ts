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
	// When true, the authorize endpoint auto-approves: it 302s straight to the
	// supplied redirect_uri with ?code=...&state=..., standing in for a user who
	// clicks "Allow" on Extension:OAuth's consent screen. The minted code is
	// `auth-<state>` so the default token handler's `access-<code>` is stable.
	autoApproveAuthorize?: boolean;
	// When true, mount a `${scriptpath}/api.php` route that records the Bearer it
	// receives (see capturedApiBearers) so a test can assert the UPSTREAM wiki
	// token — not the proxy JWT — is what reaches the wiki action API.
	captureApi?: boolean;
	// When set, the default token endpoint requires this exact `client_secret` on
	// the refresh_token grant, else it returns 401 invalid_client. This mirrors
	// MediaWiki's Extension:OAuth, whose refresh grant demands client authentication
	// even for a public consumer (unlike the auth-code+PKCE grant) — the behaviour
	// the earlier permissive fake masked.
	refreshRequiresClientSecret?: string;
}

export interface FakeAsHandle {
	readonly url: string;
	readonly app: Express;
	// Bearers seen on the captured action-API endpoint, in arrival order. Only
	// populated when captureApi is set.
	readonly capturedApiBearers: string[];
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
	const capturedApiBearers: string[] = [];
	const handle: FakeAsHandle = {
		url: '',
		app,
		capturedApiBearers,
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

	app.post('/w/rest.php/oauth2/access_token', opts.token ?? makeDefaultTokenHandler(opts));

	const oneQuery = (v: unknown): string => (typeof v === 'string' ? v : '');
	const autoApprove: RequestHandler = (req, res) => {
		const redirectUri = oneQuery(req.query.redirect_uri);
		const state = oneQuery(req.query.state);
		if (!redirectUri) {
			res.status(400).json({ error: 'invalid_request', error_description: 'missing redirect_uri' });
			return;
		}
		const cb = new URL(redirectUri);
		cb.searchParams.set('code', `auth-${state}`);
		cb.searchParams.set('state', state);
		res.redirect(302, cb.toString());
	};
	const defaultAuthorize: RequestHandler = (_req, res) => {
		res.status(404).end();
	};
	app.get(
		'/w/rest.php/oauth2/authorize',
		opts.authorize ?? (opts.autoApproveAuthorize ? autoApprove : defaultAuthorize),
	);

	if (opts.captureApi) {
		const apiHandler: RequestHandler = (req, res) => {
			const auth = req.headers.authorization;
			if (typeof auth === 'string' && auth.toLowerCase().startsWith('bearer ')) {
				capturedApiBearers.push(auth.slice(7).trim());
			}
			res.json({ query: { tokens: { csrftoken: '+\\' } } });
		};
		app.get('/w/api.php', apiHandler);
		app.post('/w/api.php', apiHandler);
	}

	server = await new Promise<Server>((resolve) => {
		const srv = app.listen(0, '127.0.0.1', () => resolve(srv));
	});
	const port = (server.address() as AddressInfo).port;
	(handle as { url: string }).url = `http://127.0.0.1:${port}`;
	return handle;
}

function makeDefaultTokenHandler(opts: FakeAsOptions): RequestHandler {
	return (req, res) => {
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
			// Mirror MediaWiki: the refresh grant authenticates the client. A public
			// consumer (no/wrong secret) is rejected with 401 invalid_client.
			if (
				opts.refreshRequiresClientSecret !== undefined &&
				String(req.body.client_secret ?? '') !== opts.refreshRequiresClientSecret
			) {
				res.status(401).json({
					error: 'invalid_client',
					error_description: 'Client authentication failed',
				});
				return;
			}
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
	};
}
