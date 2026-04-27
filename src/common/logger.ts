/* eslint-disable n/no-missing-import */
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { LoggingLevel } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

// Eight RFC 5424 severity levels, in the order LoggingLevelSchema declares them.
// Used both for the human-readable stderr prefix and the LoggingMessageNotification
// the SDK forwards to clients.
export type LogLevel = LoggingLevel;

export type LogContext = Record<string, unknown>;

const LOGGER_NAME = 'mediawiki-mcp-server';

const servers: Set<McpServer> = new Set();

export function registerServer( server: McpServer ): void {
	servers.add( server );
}

export function unregisterServer( server: McpServer ): void {
	servers.delete( server );
}

// Test-only: callers must not rely on these in production code.
export function clearRegisteredServers(): void {
	servers.clear();
}

export function getRegisteredServerCount(): number {
	return servers.size;
}

function formatStderrLine( level: LogLevel, message: string, data?: LogContext ): string {
	const prefix = level === 'info' ? '' : `${ level }: `;
	if ( data === undefined ) {
		return `${ prefix }${ message }`;
	}
	return `${ prefix }${ message } ${ JSON.stringify( data ) }`;
}

// Best-effort handler. The SDK already filters by per-session setLevel and skips
// when capabilities.logging is unset, and we have already written stderr for the
// operator. Failing here would be unhelpful noise.
const swallowNotificationError = (): undefined => undefined;

function emit( level: LogLevel, message: string, data?: LogContext ): void {
	process.stderr.write( formatStderrLine( level, message, data ) + '\n' );

	if ( servers.size === 0 ) {
		return;
	}

	const payload: LogContext = data === undefined ? { message } : { message, ...data };
	for ( const server of servers ) {
		server.sendLoggingMessage( {
			level,
			logger: LOGGER_NAME,
			data: payload
		} ).catch( swallowNotificationError );
	}
}

export const logger = {
	debug: ( message: string, data?: LogContext ): void => emit( 'debug', message, data ),
	info: ( message: string, data?: LogContext ): void => emit( 'info', message, data ),
	notice: ( message: string, data?: LogContext ): void => emit( 'notice', message, data ),
	warning: ( message: string, data?: LogContext ): void => emit( 'warning', message, data ),
	error: ( message: string, data?: LogContext ): void => emit( 'error', message, data ),
	critical: ( message: string, data?: LogContext ): void => emit( 'critical', message, data ),
	alert: ( message: string, data?: LogContext ): void => emit( 'alert', message, data ),
	emergency: ( message: string, data?: LogContext ): void => emit( 'emergency', message, data )
};

// Type aliases re-exported by `src/runtime/logger.ts` for use across the new
// architecture surface. The runtime behaviour stays in this file.
export type Logger = typeof logger;
export type LogMeta = LogContext;
