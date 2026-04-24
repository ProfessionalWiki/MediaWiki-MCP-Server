#!/usr/bin/env node

import { randomUUID } from 'node:crypto';
import express, { type RequestHandler, type Request, type Response } from 'express';
/* eslint-disable n/no-missing-import */
import {
	hostHeaderValidation,
	localhostHostValidation
} from '@modelcontextprotocol/sdk/server/middleware/hostHeaderValidation.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { createServer } from './server.js';
import { resolveHttpConfig } from './common/httpConfig.js';
import { runtimeTokenStore } from './common/requestContext.js';

const LOCALHOST_HOSTS = [ '127.0.0.1', 'localhost', '::1' ];

export function extractBearerToken( req: Request ): string | undefined {
	const raw = req.headers.authorization;
	if ( typeof raw !== 'string' ) {
		return undefined;
	}
	const first = raw.split( ',' )[ 0 ].trim();
	if ( !first.toLowerCase().startsWith( 'bearer ' ) ) {
		return undefined;
	}
	const token = first.slice( 7 ).trim();
	return token || undefined;
}

export function resolveMcpHostValidation(
	host: string,
	allowedHosts: string[] | undefined
): RequestHandler | undefined {
	if ( allowedHosts ) {
		return hostHeaderValidation( allowedHosts );
	}
	if ( LOCALHOST_HOSTS.includes( host ) ) {
		return localhostHostValidation();
	}
	if ( host === '0.0.0.0' || host === '::' ) {
		console.warn(
			`Warning: Server is binding to ${ host } without DNS rebinding protection. ` +
			'Set MCP_ALLOWED_HOSTS to restrict allowed Host-header values, ' +
			'or use authentication to protect your server.'
		);
	}
	return undefined;
}

const { host, port, allowedHosts } = resolveHttpConfig();
const app = express();
app.use( express.json() );

const hostValidation = resolveMcpHostValidation( host, allowedHosts );
if ( hostValidation ) {
	app.use( '/mcp', hostValidation );
}

const transports: { [sessionId: string]: StreamableHTTPServerTransport } = {};

app.post( '/mcp', async ( req: Request, res: Response ) => {
	const sessionId = req.headers[ 'mcp-session-id' ] as string | undefined;
	let transport: StreamableHTTPServerTransport;

	if ( sessionId && transports[ sessionId ] ) {
		transport = transports[ sessionId ];
	} else if ( !sessionId && isInitializeRequest( req.body ) ) {
		transport = new StreamableHTTPServerTransport( {
			sessionIdGenerator: () => randomUUID(),
			onsessioninitialized: ( sessionId ) => {
				transports[ sessionId ] = transport;
			}
		} );

		transport.onclose = () => {
			if ( transport.sessionId ) {
				delete transports[ transport.sessionId ];
			}
		};
		const server = createServer();

		await server.connect( transport );
	} else {
		res.status( 400 ).json( {
			jsonrpc: '2.0',
			error: {
				code: -32000,
				message: 'Bad Request: No valid session ID provided'
			},
			id: null
		} );
		return;
	}

	const runtimeToken = extractBearerToken( req );
	await runtimeTokenStore.run(
		{ runtimeToken },
		() => transport.handleRequest( req, res, req.body )
	);
} );

const handleSessionRequest = async ( req: Request, res: Response ): Promise<void> => {
	const sessionId = req.headers[ 'mcp-session-id' ] as string | undefined;
	if ( !sessionId || !transports[ sessionId ] ) {
		res.status( 400 ).send( 'Invalid or missing session ID' );
		return;
	}

	const transport = transports[ sessionId ];
	const runtimeToken = extractBearerToken( req );
	await runtimeTokenStore.run(
		{ runtimeToken },
		() => transport.handleRequest( req, res )
	);
};

app.get( '/mcp', handleSessionRequest );

app.delete( '/mcp', handleSessionRequest );

// Used for the health check in the container
app.get( '/health', ( _req: Request, res: Response ) => {
	res.status( 200 ).json( { status: 'ok' } );
} );

app.listen( port, host, () => {
	console.error( `MCP Streamable HTTP Server listening on ${ host }:${ port }` );
} );
