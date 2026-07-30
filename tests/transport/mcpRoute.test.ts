import { describe, it, expect } from 'vitest';

import express, { type Express, type Request } from 'express';
import request from 'supertest';
import { createMcpHandler, McpServer } from '@modelcontextprotocol/server';
import { createMcpRouteHandler, extractBearerToken } from '../../src/transport/mcpRoute.ts';
import { getRuntimeToken } from '../../src/runtime/requestContext.ts';

function req(authorization: string | undefined): Request {
	return { headers: { authorization } } as unknown as Request;
}

describe('extractBearerToken', () => {
	it('returns the token for a standard Bearer header', () => {
		expect(extractBearerToken(req('Bearer abc123'))).toBe('abc123');
	});
	it('is case-insensitive on the scheme', () => {
		expect(extractBearerToken(req('bearer abc123'))).toBe('abc123');
		expect(extractBearerToken(req('BEARER abc123'))).toBe('abc123');
	});
	it('trims whitespace around the token', () => {
		expect(extractBearerToken(req('Bearer   abc123  '))).toBe('abc123');
	});
	it('returns undefined for whitespace-only tokens', () => {
		expect(extractBearerToken(req('Bearer   \t'))).toBeUndefined();
		expect(extractBearerToken(req('Bearer '))).toBeUndefined();
	});
	it('returns undefined when header is missing', () => {
		expect(extractBearerToken(req(undefined))).toBeUndefined();
	});
	it('returns undefined for non-Bearer schemes', () => {
		expect(extractBearerToken(req('Basic xyz'))).toBeUndefined();
		expect(extractBearerToken(req('Digest xyz'))).toBeUndefined();
	});
	it('takes the first well-formed value from comma-joined duplicate headers', () => {
		expect(extractBearerToken(req('Bearer abc, Bearer def'))).toBe('abc');
	});
	it('returns undefined if the first comma-joined value is not Bearer', () => {
		expect(extractBearerToken(req(', Bearer abc'))).toBeUndefined();
		expect(extractBearerToken(req('Basic xyz, Bearer abc'))).toBeUndefined();
	});
});

function buildEraApp(): Express {
	const app = express();
	app.use(express.json());
	const handler = createMcpHandler(
		() => {
			const server = new McpServer(
				{ name: 'era-test-server', version: '0.0.0' },
				{ capabilities: { tools: {} } },
			);
			return server;
		},
		{ legacy: 'stateless' },
	);
	const route = createMcpRouteHandler(handler);
	app.post('/mcp', route);
	app.get('/mcp', route);
	app.delete('/mcp', route);
	return app;
}

const initializeBody = {
	jsonrpc: '2.0',
	id: 1,
	method: 'initialize',
	params: {
		protocolVersion: '2025-11-25',
		capabilities: {},
		clientInfo: { name: 'era-test-client', version: '0.0.0' },
	},
};

describe('era routing on /mcp', () => {
	it('serves a legacy initialize statelessly: 200 with NO session id header', async () => {
		const res = await request(buildEraApp())
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send(initializeBody);
		expect(res.status).toBe(200);
		expect(res.headers['mcp-session-id']).toBeUndefined();
	});

	it('serves a legacy tools/list without any session id', async () => {
		const res = await request(buildEraApp())
			.post('/mcp')
			.set('Accept', 'application/json, text/event-stream')
			.send({ jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(res.text).toContain('"tools"');
	});

	it('answers GET /mcp with 405 (no standalone SSE stream without sessions)', async () => {
		const res = await request(buildEraApp()).get('/mcp').set('Accept', 'text/event-stream');
		expect(res.status).toBe(405);
	});

	it('answers DELETE /mcp with 405 (no session to terminate)', async () => {
		const res = await request(buildEraApp()).delete('/mcp');
		expect(res.status).toBe(405);
	});
});

describe('bearer threading through the route', () => {
	function buildCaptureApp(captured: { token?: string; seen: boolean }): Express {
		const app = express();
		app.use(express.json());
		const fakeHandler = {
			fetch: async (): Promise<Response> => {
				captured.seen = true;
				captured.token = getRuntimeToken();
				return new Response(JSON.stringify({ ok: true }), {
					status: 200,
					headers: { 'content-type': 'application/json' },
				});
			},
		};
		app.post('/mcp', createMcpRouteHandler(fakeHandler));
		return app;
	}

	it('threads the raw bearer into the request context (proxy disabled)', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const res = await request(buildCaptureApp(captured))
			.post('/mcp')
			.set('Authorization', 'Bearer raw-wiki-token')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBe('raw-wiki-token');
	});

	it('leaves the context tokenless for an anonymous request', async () => {
		const captured: { token?: string; seen: boolean } = { seen: false };
		const res = await request(buildCaptureApp(captured))
			.post('/mcp')
			.send({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} });
		expect(res.status).toBe(200);
		expect(captured.seen).toBe(true);
		expect(captured.token).toBeUndefined();
	});
});
