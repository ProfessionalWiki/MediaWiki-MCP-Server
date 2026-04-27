import { createHash } from 'node:crypto';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { logger } from '../common/logger.js';
import {
	classifyError,
	type ErrorCategory
} from '../common/errorMapping.js';
import { getRuntimeToken, getSessionId } from '../common/requestContext.js';
import { wikiService } from '../common/wikiService.js';

export type ToolOutcome = 'success' | ErrorCategory;
export type TargetExtractor<A = unknown> = ( args: A ) => string;

const WARNING_OUTCOMES: ReadonlySet<ToolOutcome> = new Set( [
	'not_found',
	'invalid_input',
	'permission_denied',
	'conflict',
	'authentication',
	'rate_limited'
] );

function levelFor( outcome: ToolOutcome ): 'info' | 'warning' | 'error' {
	if ( outcome === 'success' ) {
		return 'info';
	}
	if ( outcome === 'upstream_failure' ) {
		return 'error';
	}
	return WARNING_OUTCOMES.has( outcome ) ? 'warning' : 'error';
}

function hashCaller( token: string | undefined ): string {
	if ( !token ) {
		return 'anonymous';
	}
	const hex = createHash( 'sha256' ).update( token ).digest( 'hex' );
	return `sha256:${ hex.slice( 0, 12 ) }`;
}

interface ParsedEnvelope {
	category?: ErrorCategory;
	message?: string;
}

function parseEnvelope( text: string | undefined ): ParsedEnvelope {
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

function detectTruncation( result: CallToolResult ): boolean {
	const sc = result.structuredContent;
	if ( sc !== undefined && sc !== null && typeof sc === 'object' ) {
		return 'truncation' in ( sc as Record<string, unknown> );
	}
	return false;
}

function safeTarget<A>(
	target: TargetExtractor<A> | undefined,
	args: A
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

function extractUpstreamStatus( err: unknown ): number | undefined {
	if ( err !== null && typeof err === 'object' ) {
		const response = ( err as { response?: { status?: unknown } } ).response;
		if ( response && typeof response.status === 'number' ) {
			return response.status;
		}
	}
	return undefined;
}

function sanitiseErrorMessage( err: unknown ): string {
	if ( err instanceof Error ) {
		return err.message;
	}
	return String( err );
}

function emitToolCall(
	tool: string,
	wiki: string,
	outcome: ToolOutcome,
	durationMs: number,
	caller: string,
	truncated: boolean,
	targetValue: string,
	sessionId: string | undefined,
	upstreamStatus: number | undefined,
	errorMessage: string | undefined
): void {
	const level = levelFor( outcome );
	// Snake-case keys are required by the structured log schema.
	const data: Record<string, unknown> = {
		event: 'tool_call',
		tool,
		wiki,
		outcome,
		// eslint-disable-next-line camelcase
		duration_ms: durationMs,
		caller,
		truncated
	};
	if ( targetValue !== '' ) {
		data.target = targetValue;
	}
	if ( sessionId !== undefined ) {
		// eslint-disable-next-line camelcase
		data.session_id = sessionId.slice( 0, 12 );
	}
	if ( upstreamStatus !== undefined ) {
		// eslint-disable-next-line camelcase
		data.upstream_status = upstreamStatus;
	}
	if ( errorMessage !== undefined ) {
		// eslint-disable-next-line camelcase
		data.error_message = errorMessage;
	}
	logger[ level ]( '', data );
}

export function instrumentToolCall<A>(
	toolName: string,
	handler: ( args: A ) => Promise<CallToolResult>,
	target?: TargetExtractor<A>
): ( args: A ) => Promise<CallToolResult> {
	return async ( args: A ): Promise<CallToolResult> => {
		const start = performance.now();
		let outcome: ToolOutcome = 'success';
		let truncated = false;
		let errorMessage: string | undefined;
		let upstreamStatus: number | undefined;
		let result: CallToolResult | undefined;
		let thrown: unknown;

		try {
			result = await handler( args );
			if ( result.isError ) {
				const text = ( result.content[ 0 ] as { text?: string } | undefined )?.text;
				const env = parseEnvelope( text );
				if ( env.category ) {
					outcome = env.category;
				}
				if ( env.message ) {
					errorMessage = env.message;
				}
			} else {
				truncated = detectTruncation( result );
			}
		} catch ( err ) {
			thrown = err;
			outcome = classifyError( err ).category;
			errorMessage = sanitiseErrorMessage( err );
			upstreamStatus = extractUpstreamStatus( err );
		}

		emitToolCall(
			toolName,
			wikiService.getCurrent().key,
			outcome,
			Math.round( performance.now() - start ),
			hashCaller( getRuntimeToken() ),
			truncated,
			safeTarget( target, args ),
			getSessionId(),
			upstreamStatus,
			errorMessage
		);

		if ( thrown !== undefined ) {
			throw thrown;
		}
		return result as CallToolResult;
	};
}
