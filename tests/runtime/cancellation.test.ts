import { afterEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/client';
import { InMemoryTransport } from '@modelcontextprotocol/server';
import { createServer } from '../../src/server.js';
import { clearRegisteredServers } from '../../src/runtime/logger.js';
import { getRequestSignal } from '../../src/runtime/requestContext.js';
import { fakeContext } from '../helpers/fakeContext.js';

afterEach(() => {
	clearRegisteredServers();
});

/**
 * These drive a real McpServer over a real transport rather than fabricating the
 * SDK's handler context. The signal lives at `ctx.mcpReq.signal`, and a stand-in
 * shaped the way the implementation happens to read it would pass whether or not
 * that path is right — which is exactly how an inert version of this feature can
 * ship with a green suite.
 */
describe('request cancellation reaches tool handlers', () => {
	it('exposes the SDK-supplied signal to the handler through the request scope', async () => {
		let seen: AbortSignal | undefined;
		const ctx = fakeContext({
			mwn: (async () => {
				seen = getRequestSignal();
				throw new Error('stop here — the signal is what this asserts');
			}) as never,
		});
		const server = await createServer(ctx);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'cancellation-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

		try {
			await client.callTool({ name: 'get-page', arguments: { title: 'Anything' } });
		} finally {
			await client.close();
		}

		expect(seen).toBeInstanceOf(AbortSignal);
		expect(seen?.aborted).toBe(false);
	});

	it('aborts that signal when the caller cancels the request', async () => {
		let seen: AbortSignal | undefined;
		let released: (() => void) | undefined;
		const reachedHandler = new Promise<void>((resolve) => {
			released = resolve;
		});
		const ctx = fakeContext({
			mwn: (async () => {
				seen = getRequestSignal();
				released?.();
				// Hold the handler open so the cancellation lands mid-flight,
				// which is the case the wiki request needs to be torn down in.
				await new Promise((resolve) => setTimeout(resolve, 2000));
				throw new Error('never reached');
			}) as never,
		});
		const server = await createServer(ctx);
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
		const client = new Client({ name: 'cancellation-test', version: '0.0.0' });
		await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

		// The cancellation has to name the id of the in-flight call, so record it
		// off the wire rather than assuming the client's numbering.
		let callId: string | number = 0;
		const send = clientTransport.send.bind(clientTransport);
		clientTransport.send = (async (message: { method?: string; id?: string | number }, opts) => {
			if (message.method === 'tools/call' && message.id !== undefined) {
				callId = message.id;
			}
			return send(message as never, opts as never);
		}) as typeof clientTransport.send;

		try {
			void client
				.callTool({ name: 'get-page', arguments: { title: 'Anything' } })
				.catch(() => undefined);
			await reachedHandler;

			// Sent on the wire rather than by aborting the client's own promise:
			// the SDK's client resolves a caller-side abort locally and emits no
			// notification, so aborting it would prove nothing about the server.
			await clientTransport.send({
				jsonrpc: '2.0',
				method: 'notifications/cancelled',
				params: { requestId: callId, reason: 'test' },
			});

			await vi.waitFor(() => {
				expect(seen?.aborted).toBe(true);
			});
		} finally {
			await client.close();
		}
	});
});
