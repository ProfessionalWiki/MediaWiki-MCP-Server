import { type StderrWriteSpy } from '../helpers/stderrSpy.ts';
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import type { Tool } from '../../src/runtime/tool.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { fakeLogger } from '../helpers/fakeLogger.ts';
import { createMockMwnError } from '../helpers/mock-mwn-error.ts';
import { CredentialResolutionError } from '../../src/errors/credentialResolutionError.ts';
import { withRequestFields } from '../../src/runtime/requestContext.ts';
import { getPage } from '../../src/tools/get-page.ts';
import { ContentFormat } from '../../src/results/contentFormat.ts';

const noopTool = (handle: Tool<{ x: z.ZodString }>['handle']): Tool<{ x: z.ZodString }> => ({
	name: 'get-page',
	description: 'd',
	inputSchema: { x: z.string() },
	annotations: {
		title: 't',
		readOnlyHint: true,
		destructiveHint: false,
		idempotentHint: true,
		openWorldHint: true,
	},
	handle,
});

function captureToolCallLine(spy: StderrWriteSpy): Record<string, unknown> | undefined {
	const events = spy.mock.calls
		.map((c) => String(c[0]))
		.filter((s) => s.startsWith('{'))
		.map((s) => JSON.parse(s.slice(0, -1)) as Record<string, unknown>)
		.filter((e) => e.event === 'tool_call');
	return events[events.length - 1];
}

describe('dispatcher', () => {
	it('returns successful results unchanged', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => ctx.format.ok({ ok: true }));
		const handler = dispatch(tool, ctx);
		const result = await handler({ x: 'y' });
		expect(result.isError).toBeUndefined();
	});

	it('classifies thrown errors and produces an error result', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => {
			throw createMockMwnError('permissiondenied');
		});
		const handler = dispatch(tool, ctx);
		const result = await handler({ x: 'y' });
		expect(result.isError).toBe(true);
		const envelope = JSON.parse((result.content[0] as { text: string }).text);
		expect(envelope.category).toBe('permission_denied');
		expect(envelope.code).toBe('permissiondenied');
	});

	it('applies special case for nosuchsection', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => {
			throw Object.assign(new Error('section 7 does not exist'), {
				code: 'nosuchsection',
			});
		});
		(tool as { name: string }).name = 'update-page';
		const result = await dispatch(tool, ctx)({ x: 'y' });
		const envelope = JSON.parse((result.content[0] as { text: string }).text);
		expect(envelope.message).toBe('Section 7 does not exist');
		expect(envelope.code).toBe('nosuchsection');
	});

	it('logs the failure with tool name and category', async () => {
		const logger = fakeLogger();
		const ctx = fakeContext({ logger });
		const tool = noopTool(async () => {
			throw new Error('boom');
		});
		await dispatch(tool, ctx)({ x: 'y' });
		expect(logger.error).toHaveBeenCalledWith(
			'Tool failed',
			expect.objectContaining({ tool: 'get-page' }),
		);
	});

	it('wraps untailored messages with "Failed to <verb>:" prefix', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => {
			throw new Error('boom');
		});
		(tool as { name: string; failureVerb: string }).name = 'update-page';
		(tool as { name: string; failureVerb: string }).failureVerb = 'update page';
		const result = await dispatch(tool, ctx)({ x: 'y' });
		const envelope = JSON.parse((result.content[0] as { text: string }).text);
		expect(envelope.message).toBe('Failed to update page: boom');
	});

	it('surfaces a CredentialResolutionError from the mwn provider as authentication category', async () => {
		// Simulate an exec-backed credential command failing on first use of the wiki.
		const credError = new CredentialResolutionError(
			'exec command "false" exited with code 1 (no output)',
		);
		const ctx = fakeContext({
			mwn: async () => {
				throw credError;
			},
		});

		const result = await dispatch(
			getPage,
			ctx,
		)({
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: false,
		});

		expect(result.isError).toBe(true);
		const envelope = JSON.parse((result.content[0] as { text: string }).text);
		expect(envelope.category).toBe('authentication');
		// The error message must not contain the secret/stdout — only safe text.
		expect(envelope.message).not.toContain('secret');
		expect(envelope.message).not.toContain('stdout');
	});
});

describe('dispatcher emits tool_call telemetry', () => {
	let stderrSpy: StderrWriteSpy;

	beforeEach(() => {
		vi.stubEnv('MCP_LOG_LEVEL', 'debug');
		stderrSpy = vi.spyOn(process.stderr, 'write').mockImplementation(() => true);
	});

	afterEach(() => {
		stderrSpy.mockRestore();
		vi.unstubAllEnvs();
	});

	it('emits a success tool_call event on a successful handler', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => ctx.format.ok({ ok: true }));
		await dispatch(tool, ctx)({ x: 'y' });

		const line = captureToolCallLine(stderrSpy);
		expect(line).toBeDefined();
		expect(line!.tool).toBe('get-page');
		expect(line!.outcome).toBe('success');
		expect(line!.level).toBe('info');
	});

	it('emits an error tool_call event when the handler throws', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => {
			throw createMockMwnError('permissiondenied');
		});
		await dispatch(tool, ctx)({ x: 'y' });

		const line = captureToolCallLine(stderrSpy);
		expect(line).toBeDefined();
		expect(line!.outcome).toBe('permission_denied');
		expect(line!.level).toBe('warning');
		expect(typeof line!.error_message).toBe('string');
	});

	it('reports an aborted call as cancelled rather than an upstream failure', async () => {
		const ctx = fakeContext();
		// What a torn-down request actually looks like from the tool's side: mwn
		// surfaces the abort as a malformed response, not as an abort, so the
		// classifier would otherwise call this a wiki outage.
		const tool = noopTool(async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'pages')");
		});
		const controller = new AbortController();
		controller.abort();

		await withRequestFields({ signal: controller.signal }, () => dispatch(tool, ctx)({ x: 'y' }));

		const line = captureToolCallLine(stderrSpy);
		expect(line).toBeDefined();
		expect(line!.outcome).toBe('cancelled');
		expect(line!.level).toBe('info');
	});

	it('still reports a genuine failure as an upstream failure when nothing was cancelled', async () => {
		const ctx = fakeContext();
		const tool = noopTool(async () => {
			throw new TypeError("Cannot read properties of undefined (reading 'pages')");
		});
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, () => dispatch(tool, ctx)({ x: 'y' }));

		const line = captureToolCallLine(stderrSpy);
		expect(line!.outcome).toBe('upstream_failure');
		expect(line!.level).toBe('error');
	});
});
