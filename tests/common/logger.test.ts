import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
/* eslint-disable n/no-missing-import */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import {
	clearRegisteredServers,
	getRegisteredServerCount,
	logger,
	registerServer,
	unregisterServer,
	type LogContext,
	type LogLevel
} from '../../src/common/logger.js';

interface FakeServer {
	sendLoggingMessage: ReturnType<typeof vi.fn>;
}

function fakeServer(): FakeServer {
	return {
		sendLoggingMessage: vi.fn().mockResolvedValue( undefined )
	};
}

function asMcpServer( fake: FakeServer ): McpServer {
	return fake as unknown as McpServer;
}

describe( 'logger', () => {
	let stderrSpy: ReturnType<typeof vi.spyOn>;

	beforeEach( () => {
		stderrSpy = vi.spyOn( process.stderr, 'write' ).mockImplementation( () => true );
	} );

	afterEach( () => {
		clearRegisteredServers();
		stderrSpy.mockRestore();
	} );

	function lastStderrLine(): string {
		const calls = stderrSpy.mock.calls;
		expect( calls.length ).toBeGreaterThan( 0 );
		return String( calls[ calls.length - 1 ][ 0 ] );
	}

	describe( 'stderr output', () => {
		it( 'writes a plain message at info level without a level prefix', () => {
			logger.info( 'listening on 127.0.0.1:3000' );
			expect( lastStderrLine() ).toBe( 'listening on 127.0.0.1:3000\n' );
		} );

		it( 'prefixes non-info levels with the level name', () => {
			logger.warning( 'plaintext credential' );
			expect( lastStderrLine() ).toBe( 'warning: plaintext credential\n' );
		} );

		it( 'appends serialized data when provided', () => {
			logger.error( 'tool registration failed', { tool: 'get-page', error: 'boom' } );
			expect( lastStderrLine() ).toBe(
				'error: tool registration failed {"tool":"get-page","error":"boom"}\n'
			);
		} );

		it.each<[LogLevel, string]>( [
			[ 'debug', 'debug: x\n' ],
			[ 'info', 'x\n' ],
			[ 'notice', 'notice: x\n' ],
			[ 'warning', 'warning: x\n' ],
			[ 'error', 'error: x\n' ],
			[ 'critical', 'critical: x\n' ],
			[ 'alert', 'alert: x\n' ],
			[ 'emergency', 'emergency: x\n' ]
		] )( '%s emits the expected stderr prefix', ( level, expected ) => {
			logger[ level ]( 'x' );
			expect( lastStderrLine() ).toBe( expected );
		} );
	} );

	describe( 'server registration', () => {
		it( 'broadcasts to a registered server', () => {
			const fake = fakeServer();
			registerServer( asMcpServer( fake ) );

			logger.warning( 'session bearer mismatch', { sessionId: 'abc' } );

			expect( fake.sendLoggingMessage ).toHaveBeenCalledTimes( 1 );
			expect( fake.sendLoggingMessage ).toHaveBeenCalledWith( {
				level: 'warning',
				logger: 'mediawiki-mcp-server',
				data: { message: 'session bearer mismatch', sessionId: 'abc' }
			} );
		} );

		it( 'broadcasts to every registered server', () => {
			const fakeA = fakeServer();
			const fakeB = fakeServer();
			registerServer( asMcpServer( fakeA ) );
			registerServer( asMcpServer( fakeB ) );

			logger.info( 'hello' );

			expect( fakeA.sendLoggingMessage ).toHaveBeenCalledTimes( 1 );
			expect( fakeB.sendLoggingMessage ).toHaveBeenCalledTimes( 1 );
		} );

		it( 'stops sending to a server after it is unregistered', () => {
			const fake = fakeServer();
			registerServer( asMcpServer( fake ) );
			unregisterServer( asMcpServer( fake ) );

			logger.info( 'after unregister' );

			expect( fake.sendLoggingMessage ).not.toHaveBeenCalled();
		} );

		it( 'is a no-op when no servers are registered (stderr only)', () => {
			logger.info( 'startup line' );
			// No throw, stderr still written
			expect( stderrSpy ).toHaveBeenCalled();
		} );

		it( 'omits the data payload key when no context is supplied', () => {
			const fake = fakeServer();
			registerServer( asMcpServer( fake ) );

			logger.info( 'plain' );

			const params = fake.sendLoggingMessage.mock.calls[ 0 ][ 0 ] as {
				data: LogContext;
			};
			expect( params.data ).toEqual( { message: 'plain' } );
		} );
	} );

	describe( 'fault tolerance', () => {
		it( 'swallows rejections from sendLoggingMessage so logging never throws', async () => {
			const fake = fakeServer();
			fake.sendLoggingMessage.mockRejectedValueOnce( new Error( 'transport closed' ) );
			registerServer( asMcpServer( fake ) );

			expect( () => logger.error( 'boom' ) ).not.toThrow();
			// Allow microtask to flush so the .catch handler runs.
			await new Promise( ( resolve ) => setImmediate( resolve ) );
		} );
	} );
} );

// Mirrors the registration pattern from createServer() in src/server.ts so the
// test exercises the same onclose-wrapping path used in production.
function buildRegisteredServer(): McpServer {
	const server = new McpServer(
		{ name: 'logger-integration-test', version: '0.0.0' },
		{ capabilities: { logging: {} } }
	);
	registerServer( server );
	const previousOnClose = server.server.onclose;
	server.server.onclose = (): void => {
		unregisterServer( server );
		previousOnClose?.();
	};
	return server;
}

describe( 'logger registry lifecycle (integration)', () => {
	afterEach( () => {
		clearRegisteredServers();
	} );

	it( 'unregisters the server when its transport closes via the client', async () => {
		const server = buildRegisteredServer();
		const client = new Client( { name: 'logger-test-client', version: '0.0.0' } );
		const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();

		await Promise.all( [
			server.connect( serverTransport ),
			client.connect( clientTransport )
		] );

		expect( getRegisteredServerCount() ).toBe( 1 );

		await client.close();

		expect( getRegisteredServerCount() ).toBe( 0 );
	} );

	it( 'unregisters the server when the server itself closes the transport', async () => {
		const server = buildRegisteredServer();
		const client = new Client( { name: 'logger-test-client', version: '0.0.0' } );
		const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();

		await Promise.all( [
			server.connect( serverTransport ),
			client.connect( clientTransport )
		] );

		expect( getRegisteredServerCount() ).toBe( 1 );

		await server.close();

		expect( getRegisteredServerCount() ).toBe( 0 );
	} );
} );
