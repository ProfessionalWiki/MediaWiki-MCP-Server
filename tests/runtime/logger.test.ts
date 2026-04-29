import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import {
	clearRegisteredServers,
	emitTelemetryEvent,
	getRegisteredServerCount,
	logger,
	registerServer,
	unregisterServer,
	type LogContext,
	type LogLevel,
} from '../../src/runtime/logger.js';

interface FakeServer {
	sendLoggingMessage: ReturnType<typeof vi.fn>;
}

function fakeServer(): FakeServer {
	return {
		sendLoggingMessage: vi.fn().mockResolvedValue(undefined),
	};
}

function asMcpServer(fake: FakeServer): McpServer {
	return fake as unknown as McpServer;
}

describe('logger', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		clearRegisteredServers();
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	describe('stderr output (JSON per line)', () => {
		function lastJson(): Record<string, unknown> {
			const calls = stderrSpy.mock.calls;
			expect(calls.length).toBeGreaterThan(0);
			const raw = String(calls[calls.length - 1][0]);
			expect(raw.endsWith('\n')).toBe(true);
			return JSON.parse(raw.slice(0, -1)) as Record<string, unknown>;
		}

		it('emits a JSON line with ts, level, and message at info', () => {
			logger.info('listening on 127.0.0.1:3000');
			const obj = lastJson();
			expect(obj.level).toBe('info');
			expect(obj.message).toBe('listening on 127.0.0.1:3000');
			expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
		});

		it('records the level field for non-info levels', () => {
			logger.warning('plaintext credential');
			expect(lastJson().level).toBe('warning');
		});

		it('merges data fields at the top level', () => {
			logger.error('tool registration failed', { tool: 'get-page', error: 'boom' });
			const obj = lastJson();
			expect(obj.message).toBe('tool registration failed');
			expect(obj.tool).toBe('get-page');
			expect(obj.error).toBe('boom');
		});

		it('omits the message field when message is empty', () => {
			logger.info('', { event: 'tool_call', tool: 'get-page' });
			const obj = lastJson();
			expect('message' in obj).toBe(false);
			expect(obj.event).toBe('tool_call');
			expect(obj.tool).toBe('get-page');
		});

		it('overrides reserved keys (ts, level, message) supplied via data', () => {
			logger.info('real', { ts: 'fake', level: 'fake', message: 'fake', other: 'kept' });
			const obj = lastJson();
			expect(obj.message).toBe('real');
			expect(obj.level).toBe('info');
			expect(obj.ts).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/);
			expect(obj.other).toBe('kept');
		});

		it.each<[LogLevel]>([
			['debug'],
			['info'],
			['notice'],
			['warning'],
			['error'],
			['critical'],
			['alert'],
			['emergency'],
		])('%s emits the matching level field', (level) => {
			logger[level]('x');
			expect(lastJson().level).toBe(level);
		});
	});

	describe('server registration', () => {
		it('broadcasts to a registered server', () => {
			const fake = fakeServer();
			registerServer(asMcpServer(fake));

			logger.warning('session bearer mismatch', { sessionId: 'abc' });

			expect(fake.sendLoggingMessage).toHaveBeenCalledTimes(1);
			expect(fake.sendLoggingMessage).toHaveBeenCalledWith({
				level: 'warning',
				logger: 'mediawiki-mcp-server',
				data: { message: 'session bearer mismatch', sessionId: 'abc' },
			});
		});

		it('broadcasts to every registered server', () => {
			const fakeA = fakeServer();
			const fakeB = fakeServer();
			registerServer(asMcpServer(fakeA));
			registerServer(asMcpServer(fakeB));

			logger.info('hello');

			expect(fakeA.sendLoggingMessage).toHaveBeenCalledTimes(1);
			expect(fakeB.sendLoggingMessage).toHaveBeenCalledTimes(1);
		});

		it('stops sending to a server after it is unregistered', () => {
			const fake = fakeServer();
			registerServer(asMcpServer(fake));
			unregisterServer(asMcpServer(fake));

			logger.info('after unregister');

			expect(fake.sendLoggingMessage).not.toHaveBeenCalled();
		});

		it('is a no-op when no servers are registered (stderr only)', () => {
			logger.info('startup line');
			// No throw, stderr still written
			expect(stderrSpy).toHaveBeenCalled();
		});

		it('omits the data payload key when no context is supplied', () => {
			const fake = fakeServer();
			registerServer(asMcpServer(fake));

			logger.info('plain');

			const params = fake.sendLoggingMessage.mock.calls[0][0] as {
				data: LogContext;
			};
			expect(params.data).toEqual({ message: 'plain' });
		});
	});

	describe('fault tolerance', () => {
		it('swallows rejections from sendLoggingMessage so logging never throws', async () => {
			const fake = fakeServer();
			fake.sendLoggingMessage.mockRejectedValueOnce(new Error('transport closed'));
			registerServer(asMcpServer(fake));

			expect(() => logger.error('boom')).not.toThrow();
			// Allow microtask to flush so the .catch handler runs.
			await new Promise((resolve) => setImmediate(resolve));
		});
	});

	describe('MCP_LOG_LEVEL threshold', () => {
		it('drops below-threshold stderr writes', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			logger.info('should be filtered');
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('emits at-or-above-threshold messages', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			logger.warning('kept');
			logger.error('also kept');
			expect(stderrSpy).toHaveBeenCalledTimes(2);
		});

		it('silent drops every level including emergency', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'silent');
			logger.debug('no');
			logger.info('no');
			logger.warning('no');
			logger.error('no');
			logger.emergency('no');
			expect(stderrSpy).not.toHaveBeenCalled();
		});

		it('unset env behaves like debug (everything emits)', () => {
			vi.stubEnv('MCP_LOG_LEVEL', '');
			logger.debug('kept');
			logger.info('kept');
			expect(stderrSpy).toHaveBeenCalledTimes(2);
		});

		it('throws on first emit with an invalid value', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'verbose');
			expect(() => logger.info('x')).toThrow(
				/MCP_LOG_LEVEL.*verbose.*debug.*info.*notice.*warning.*error.*critical.*alert.*emergency.*silent/s,
			);
		});

		it('does not broadcast to registered servers when below threshold', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			const fake = fakeServer();
			registerServer(asMcpServer(fake));
			logger.info('filtered');
			expect(fake.sendLoggingMessage).not.toHaveBeenCalled();
			unregisterServer(asMcpServer(fake));
		});

		it('gates emitTelemetryEvent with the same threshold', () => {
			vi.stubEnv('MCP_LOG_LEVEL', 'warning');
			emitTelemetryEvent('info', { event: 'tool_call', tool: 'x' });
			expect(stderrSpy).not.toHaveBeenCalled();
			emitTelemetryEvent('error', { event: 'tool_call', tool: 'x' });
			expect(stderrSpy).toHaveBeenCalledTimes(1);
		});
	});
});

// Mirrors the registration pattern from createServer() in src/server.ts so the
// test exercises the same onclose-wrapping path used in production.
function buildRegisteredServer(): McpServer {
	const server = new McpServer(
		{ name: 'logger-integration-test', version: '0.0.0' },
		{ capabilities: { logging: {} } },
	);
	registerServer(server);
	const previousOnClose = server.server.onclose;
	server.server.onclose = (): void => {
		unregisterServer(server);
		previousOnClose?.();
	};
	return server;
}

describe('logger registry lifecycle (integration)', () => {
	afterEach(() => {
		clearRegisteredServers();
	});

	it('unregisters the server when its transport closes via the client', async () => {
		const server = buildRegisteredServer();
		const client = new Client({ name: 'logger-test-client', version: '0.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		expect(getRegisteredServerCount()).toBe(1);

		await client.close();

		expect(getRegisteredServerCount()).toBe(0);
	});

	it('unregisters the server when the server itself closes the transport', async () => {
		const server = buildRegisteredServer();
		const client = new Client({ name: 'logger-test-client', version: '0.0.0' });
		const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

		await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);

		expect(getRegisteredServerCount()).toBe(1);

		await server.close();

		expect(getRegisteredServerCount()).toBe(0);
	});
});
