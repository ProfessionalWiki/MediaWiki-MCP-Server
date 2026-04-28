import type { ZodRawShape, z } from 'zod';
/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { applySpecialCase } from '../errors/specialCases.js';

const FAILURE_VERB: Record<string, string> = {
	'get-page': 'retrieve page data',
	'get-pages': 'retrieve pages',
	'get-page-history': 'retrieve page history',
	'get-recent-changes': 'retrieve recent changes',
	'get-revision': 'retrieve revision data',
	'get-file': 'retrieve file data',
	'get-category-members': 'retrieve category members',
	'search-page': 'retrieve search data',
	'search-page-by-prefix': 'retrieve search data',
	'parse-wikitext': 'preview wikitext',
	'compare-pages': 'compare pages',
	'create-page': 'create page',
	'update-page': 'update page',
	'delete-page': 'delete page',
	'undelete-page': 'undelete page',
	'upload-file': 'upload file',
	'upload-file-from-url': 'upload file',
	'update-file': 'update file',
	'update-file-from-url': 'update file',
	'add-wiki': 'add wiki',
	'remove-wiki': 'remove wiki',
	'set-wiki': 'set wiki'
};

function failurePrefix( toolName: string ): string {
	return `Failed to ${ FAILURE_VERB[ toolName ] ?? toolName }`;
}

export function dispatch<TSchema extends ZodRawShape>(
	tool: Tool<TSchema>,
	ctx: ToolContext
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
			const message = tailored ?
				overridden.message :
				`${ failurePrefix( tool.name ) }: ${ overridden.message }`;

			ctx.logger.error( 'Tool failed', {
				tool: tool.name,
				category: overridden.category,
				code: overridden.code
			} );
			return ctx.format.error( overridden.category, message, overridden.code );
		}
	};
}
