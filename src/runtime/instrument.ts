import { createHash } from 'node:crypto';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { emitTelemetryEvent } from './logger.js';
import { recordToolCall } from './metrics.js';
import type { ErrorCategory } from '../errors/classifyError.js';

export type ToolOutcome = 'success' | ErrorCategory;

const WARNING_OUTCOMES: ReadonlySet<ToolOutcome> = new Set( [
	'not_found',
	'invalid_input',
	'permission_denied',
	'conflict',
	'authentication',
	'rate_limited'
] );

export function levelFor( outcome: ToolOutcome ): 'info' | 'warning' | 'error' {
	if ( outcome === 'success' ) {
		return 'info';
	}
	if ( outcome === 'upstream_failure' ) {
		return 'error';
	}
	return WARNING_OUTCOMES.has( outcome ) ? 'warning' : 'error';
}

export function hashCaller( token: string | undefined ): string {
	if ( !token ) {
		return 'anonymous';
	}
	const hex = createHash( 'sha256' ).update( token ).digest( 'hex' );
	return `sha256:${ hex.slice( 0, 12 ) }`;
}

export interface ParsedEnvelope {
	category?: ErrorCategory;
	message?: string;
}

export function parseEnvelope( text: string | undefined ): ParsedEnvelope {
	if ( !text ) {
		return {};
	}
	try {
		const obj = JSON.parse( text );
		if ( obj && typeof obj === 'object' ) {
			return obj as ParsedEnvelope;
		}
	} catch {
		// leave empty
	}
	return {};
}

export function detectTruncation( result: CallToolResult ): boolean {
	const sc = result.structuredContent;
	if ( sc !== undefined && sc !== null && typeof sc === 'object' ) {
		return 'truncation' in ( sc as Record<string, unknown> );
	}
	return false;
}

export function extractUpstreamStatus( err: unknown ): number | undefined {
	if ( err !== null && typeof err === 'object' ) {
		const response = ( err as { response?: { status?: unknown } } ).response;
		if ( response && typeof response.status === 'number' ) {
			return response.status;
		}
	}
	return undefined;
}

export function safeTarget<TArgs>(
	target: ( ( args: TArgs ) => string ) | undefined,
	args: TArgs
): string {
	if ( target === undefined ) {
		return '';
	}
	try {
		return target( args );
	} catch {
		return '';
	}
}

export interface EmitToolCallOptions<TArgs> {
	readonly toolName: string;
	readonly target?: ( args: TArgs ) => string;
	readonly args: TArgs;
	readonly started: number;
	readonly result: CallToolResult;
	readonly outcome: ToolOutcome;
	readonly upstreamStatus: number | undefined;
	readonly errorMessage: string | undefined;
	readonly runtimeToken: string | undefined;
	readonly sessionId: string | undefined;
	readonly wikiKey: string;
}

export function emitToolCall<TArgs>( opts: EmitToolCallOptions<TArgs> ): void {
	const level = levelFor( opts.outcome );
	const targetValue = safeTarget( opts.target, opts.args );
	const truncated = opts.outcome === 'success' ? detectTruncation( opts.result ) : false;
	const durationMs = Math.round( performance.now() - opts.started );
	// Snake-case keys are required by the structured log schema.
	const data: Record<string, unknown> = {
		event: 'tool_call',
		tool: opts.toolName,
		wiki: opts.wikiKey,
		outcome: opts.outcome,
		// eslint-disable-next-line camelcase
		duration_ms: durationMs,
		caller: hashCaller( opts.runtimeToken ),
		truncated
	};
	if ( targetValue !== '' ) {
		data.target = targetValue;
	}
	if ( opts.sessionId !== undefined ) {
		// eslint-disable-next-line camelcase
		data.session_id = opts.sessionId.replace( /-/g, '' ).slice( 0, 12 );
	}
	if ( opts.upstreamStatus !== undefined ) {
		// eslint-disable-next-line camelcase
		data.upstream_status = opts.upstreamStatus;
	}
	if ( opts.errorMessage !== undefined ) {
		// eslint-disable-next-line camelcase
		data.error_message = opts.errorMessage;
	}
	emitTelemetryEvent( level, data );
	recordToolCall( {
		tool: opts.toolName,
		wiki: opts.wikiKey,
		outcome: opts.outcome,
		durationMs,
		upstreamStatus: opts.upstreamStatus
	} );
}
