import { createHash } from 'node:crypto';
import type { ZodRawShape, z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { applySpecialCase } from '../errors/specialCases.js';
import { emitTelemetryEvent } from './logger.js';
import { getRuntimeToken, getSessionId } from '../transport/requestContext.js';
import type { ErrorCategory } from '../errors/classifyError.js';

type ToolOutcome = 'success' | ErrorCategory;

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

function extractUpstreamStatus( err: unknown ): number | undefined {
	if ( err !== null && typeof err === 'object' ) {
		const response = ( err as { response?: { status?: unknown } } ).response;
		if ( response && typeof response.status === 'number' ) {
			return response.status;
		}
	}
	return undefined;
}

function safeTarget<TArgs>(
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

function emitToolCall(
	toolName: string,
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
		tool: toolName,
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
		data.session_id = sessionId.replace( /-/g, '' ).slice( 0, 12 );
	}
	if ( upstreamStatus !== undefined ) {
		// eslint-disable-next-line camelcase
		data.upstream_status = upstreamStatus;
	}
	if ( errorMessage !== undefined ) {
		// eslint-disable-next-line camelcase
		data.error_message = errorMessage;
	}
	emitTelemetryEvent( level, data );
}

export function dispatch<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext>(
	tool: Tool<TSchema, TCtx>,
	ctx: TCtx
): ( args: z.infer<z.ZodObject<TSchema>> ) => Promise<CallToolResult> {
	return async ( args ) => {
		const start = performance.now();
		let outcome: ToolOutcome = 'success';
		let truncated = false;
		let errorMessage: string | undefined;
		let upstreamStatus: number | undefined;
		let result: CallToolResult;

		try {
			result = await tool.handle( args, ctx );
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
			const classified = ctx.errors.classify( err );
			const overridden = applySpecialCase( tool.name, classified, err );

			outcome = overridden.category;
			upstreamStatus = extractUpstreamStatus( err );

			// If a special case produced a tailored message (e.g. "Section X does not exist"),
			// use it verbatim. Otherwise prepend the standard "Failed to <verb>: " prefix to
			// the raw error message — matching today's per-tool conventions.
			const rawMessage = ( err as Error ).message ?? 'Unknown error';
			const tailored = overridden.message !== rawMessage;
			const verb = tool.failureVerb ?? tool.name;
			const finalMessage = tailored ?
				overridden.message :
				`Failed to ${ verb }: ${ overridden.message }`;
			errorMessage = finalMessage;

			ctx.logger.error( 'Tool failed', {
				tool: tool.name,
				category: overridden.category,
				code: overridden.code
			} );
			result = ctx.format.error( overridden.category, finalMessage, overridden.code );
		}

		emitToolCall(
			tool.name,
			ctx.selection.getCurrent().key,
			outcome,
			Math.round( performance.now() - start ),
			hashCaller( getRuntimeToken() ),
			truncated,
			safeTarget( tool.target, args ),
			getSessionId(),
			upstreamStatus,
			errorMessage
		);

		return result;
	};
}
