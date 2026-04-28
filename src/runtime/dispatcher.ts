import type { ZodRawShape, z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { applySpecialCase } from '../errors/specialCases.js';
import { getRuntimeToken, getSessionId } from '../transport/requestContext.js';
import {
	emitToolCall,
	extractUpstreamStatus,
	parseEnvelope,
	type ToolOutcome
} from './instrument.js';

export function dispatch<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext>(
	tool: Tool<TSchema, TCtx>,
	ctx: TCtx
): ( args: z.infer<z.ZodObject<TSchema>> ) => Promise<CallToolResult> {
	return async ( args ) => {
		const started = performance.now();
		let outcome: ToolOutcome = 'success';
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

		emitToolCall( {
			toolName: tool.name,
			target: tool.target,
			args,
			started,
			result,
			outcome,
			upstreamStatus,
			errorMessage,
			runtimeToken: getRuntimeToken(),
			sessionId: getSessionId(),
			wikiKey: ctx.selection.getCurrent().key
		} );

		return result;
	};
}
