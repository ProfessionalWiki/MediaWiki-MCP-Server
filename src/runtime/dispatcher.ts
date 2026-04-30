import type { ZodRawShape, z } from 'zod';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { Tool } from './tool.js';
import type { ToolContext } from './context.js';
import { applySpecialCase } from '../errors/specialCases.js';
import { errorMessage } from '../errors/isErrnoException.js';
import { getRuntimeToken, getSessionId, withRequestContext } from '../transport/requestContext.js';
import {
	emitToolCall,
	extractUpstreamStatus,
	parseEnvelope,
	type ToolOutcome,
} from './instrument.js';
import { acquireToken } from '../auth/acquireToken.js';

// Tools that operate on server-local state (the wiki registry, the OAuth token
// store) rather than the active wiki's API. They must not be blocked by an
// OAuth gate keyed on the active wiki — otherwise a wiki whose OAuth has gone
// stale would render set-wiki, remove-wiki, and the oauth-* tools unreachable,
// with no way for the caller to escape it. add-wiki targets a different wiki
// entirely and equally has no business borrowing the active wiki's token.
const TOOLS_BYPASSING_ACTIVE_WIKI_AUTH: ReadonlySet<string> = new Set([
	'add-wiki',
	'set-wiki',
	'remove-wiki',
	'oauth-status',
	'oauth-logout',
]);

export function dispatch<TSchema extends ZodRawShape, TCtx extends ToolContext = ToolContext>(
	tool: Tool<TSchema, TCtx>,
	ctx: TCtx,
): (args: z.infer<z.ZodObject<TSchema>>) => Promise<CallToolResult> {
	return async (args) => {
		const { key: wikiKey, config: wiki } = ctx.selection.getCurrent();
		const useOauth =
			ctx.transport === 'stdio' &&
			!TOOLS_BYPASSING_ACTIVE_WIKI_AUTH.has(tool.name) &&
			typeof wiki.oauth2ClientId === 'string' &&
			wiki.oauth2ClientId.trim() !== '';

		if (useOauth) {
			let token: string;
			try {
				token = await acquireToken(wikiKey, {
					wiki: { server: wiki.server, scriptpath: wiki.scriptpath },
					oauth2ClientId: wiki.oauth2ClientId,
					callbackPort:
						typeof wiki.oauth2CallbackPort === 'number' ? wiki.oauth2CallbackPort : undefined,
				});
			} catch (err: unknown) {
				const message = err instanceof Error ? err.message : String(err);
				return ctx.format.error('authentication', `OAuth login required: ${message}`);
			}
			return withRequestContext(token, undefined, () => runDispatchInner(tool, ctx, args));
		}
		return runDispatchInner(tool, ctx, args);
	};
}

async function runDispatchInner<TSchema extends ZodRawShape, TCtx extends ToolContext>(
	tool: Tool<TSchema, TCtx>,
	ctx: TCtx,
	args: z.infer<z.ZodObject<TSchema>>,
): Promise<CallToolResult> {
	const started = performance.now();
	let outcome: ToolOutcome = 'success';
	let errorText: string | undefined;
	let upstreamStatus: number | undefined;
	let result: CallToolResult;

	try {
		result = await tool.handle(args, ctx);
		if (result.isError) {
			const first = result.content[0];
			const text =
				first !== undefined && 'text' in first && typeof first.text === 'string'
					? first.text
					: undefined;
			const env = parseEnvelope(text);
			// Fall back to upstream_failure when the envelope is missing or
			// unparseable rather than letting outcome stay 'success' — that
			// would emit a misleading info-level telemetry line on a result
			// that's flagged as an error.
			outcome = env.category ?? 'upstream_failure';
			if (env.message) {
				errorText = env.message;
			}
		}
	} catch (err) {
		const classified = ctx.errors.classify(err);
		const overridden = applySpecialCase(tool.name, classified, err);

		outcome = overridden.category;
		upstreamStatus = extractUpstreamStatus(err);

		// If a special case produced a tailored message (e.g. "Section X does not exist"),
		// use it verbatim. Otherwise prepend the standard "Failed to <verb>: " prefix to
		// the raw error message — matching today's per-tool conventions.
		const rawMessage = errorMessage(err);
		const tailored = overridden.message !== rawMessage;
		const verb = tool.failureVerb ?? tool.name;
		const finalMessage = tailored ? overridden.message : `Failed to ${verb}: ${overridden.message}`;
		errorText = finalMessage;

		ctx.logger.error('Tool failed', {
			tool: tool.name,
			category: overridden.category,
			code: overridden.code,
		});
		result = ctx.format.error(overridden.category, finalMessage, overridden.code);
	}

	emitToolCall({
		toolName: tool.name,
		target: tool.target,
		args,
		started,
		result,
		outcome,
		upstreamStatus,
		errorMessage: errorText,
		runtimeToken: getRuntimeToken(),
		sessionId: getSessionId(),
		wikiKey: ctx.selection.getCurrent().key,
	});

	return result;
}
