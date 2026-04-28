import type { ZodRawShape, z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { applySpecialCase } from '../errors/specialCases.js';

export function dispatch<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext>(
	tool: Tool<TSchema, TCtx>,
	ctx: TCtx
): ( args: z.infer<z.ZodObject<TSchema>> ) => Promise<CallToolResult> {
	return async ( args ) => {
		try {
			return await tool.handle( args, ctx );
		} catch ( err ) {
			const classified = ctx.errors.classify( err );
			const overridden = applySpecialCase( tool.name, classified, err );

			// If a special case produced a tailored message (e.g. "Section X does not exist"),
			// use it verbatim. Otherwise prepend the standard "Failed to <verb>: " prefix to
			// the raw error message — matching today's per-tool conventions.
			const rawMessage = ( err as Error ).message ?? 'Unknown error';
			const tailored = overridden.message !== rawMessage;
			const verb = tool.failureVerb ?? tool.name;
			const message = tailored ?
				overridden.message :
				`Failed to ${ verb }: ${ overridden.message }`;

			ctx.logger.error( 'Tool failed', {
				tool: tool.name,
				category: overridden.category,
				code: overridden.code
			} );
			return ctx.format.error( overridden.category, message, overridden.code );
		}
	};
}
