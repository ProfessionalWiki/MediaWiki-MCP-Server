// tests/runtime/dispatch.oauth.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';
import type { ToolContext } from '../../src/runtime/context.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import type { Tool } from '../../src/runtime/tool.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.js';
import { useTempTokenStore } from '../helpers/tempTokenStore.js';
import { getRequestWiki, getRuntimeToken } from '../../src/transport/requestContext.js';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.js';
import { _resetBrowserAuthDedupForTesting } from '../../src/auth/browserAuth.js';
import { _resetRefreshDedupForTesting } from '../../src/auth/tokenRefresh.js';

vi.mock('open', () => ({ default: vi.fn() }));
import openMod from 'open';

useTempTokenStore();

let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
	_resetBrowserAuthDedupForTesting();
	_resetRefreshDedupForTesting();
	vi.clearAllMocks();
});

// Builds a ctx whose single wiki (keyed `wiki-key`) carries the given config,
// with a registry + activeWiki that agree on it — the dispatcher resolves and
// validates the wiki before applying the OAuth gate.
function ctxForWiki(config: WikiConfig, transport: ToolContext['transport']): ToolContext {
	const registry: Record<string, WikiConfig> = { 'wiki-key': config };
	return fakeContext({
		transport,
		wikis: {
			getAll: () => registry,
			get: (key: string) => registry[key],
			add: () => {},
			remove: () => {},
			isManagementAllowed: () => true,
		},
		activeWiki: {
			get: () => ({ key: getRequestWiki() ?? 'wiki-key', config }),
			getDefaultKey: () => 'wiki-key',
		},
	});
}

/** A dummy tool that returns whatever getRuntimeToken() sees at invocation time. */
const tokenCaptureTool: Tool<Record<string, never>> = {
	name: 'dummy',
	description: 'd',
	inputSchema: {},
	annotations: {},
	async handle(): Promise<CallToolResult> {
		return { content: [{ type: 'text', text: getRuntimeToken() ?? '' }] };
	},
};

describe('dispatch OAuth integration', () => {
	it('stdio + oauth2ClientId: binds token and tool sees getRuntimeToken()', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const ctx = ctxForWiki(
			{
				sitename: 'Test',
				server: fakeAs.url,
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'my-client',
			} as never,
			'stdio',
		);

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/^access-CODE-/);
	});

	it('stdio without oauth2ClientId: does not call acquireToken / open', async () => {
		fakeAs = await startFakeAs();

		const ctx = fakeContext({
			transport: 'stdio',
			// default fakeContext activeWiki has no oauth2ClientId
		});

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		// No token bound — getRuntimeToken() returns undefined
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe('');
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('http + oauth2ClientId: does not call acquireToken / open', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);

		const ctx = ctxForWiki(
			{
				sitename: 'Test',
				server: fakeAs.url,
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'my-client',
			} as never,
			'http',
		);

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		// HTTP transport: no token acquired, getRuntimeToken() returns undefined
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe('');
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('acquireToken failure: tool is NOT invoked; returns authentication error', async () => {
		// Point server at a non-existent URL so acquireToken's metadata fetch fails.
		const ctx = ctxForWiki(
			{
				sitename: 'Broken',
				server: 'http://127.0.0.1:1', // nothing listening here
				articlepath: '/wiki',
				scriptpath: '/w',
				oauth2ClientId: 'my-client',
			} as never,
			'stdio',
		);

		let toolInvoked = false;
		const probeTool: Tool<Record<string, never>> = {
			name: 'probe',
			description: 'd',
			inputSchema: {},
			annotations: {},
			async handle(): Promise<CallToolResult> {
				toolInvoked = true;
				return { content: [{ type: 'text', text: 'should not reach here' }] };
			},
		};

		const result = await dispatch(probeTool, ctx)({});
		expect(toolInvoked).toBe(false);
		expect(result.isError).toBe(true);
		const envelope = JSON.parse((result.content[0] as { text: string }).text) as {
			category: string;
			message: string;
		};
		expect(envelope.category).toBe('authentication');
		expect(envelope.message).toContain('OAuth login required:');
	});

	it.each(['add-wiki', 'remove-wiki', 'oauth-status', 'oauth-logout'])(
		'%s bypasses the OAuth gate even when the wiki has oauth2ClientId set',
		async (toolName) => {
			// Wiki points at a URL where nothing is listening — so if the dispatcher
			// tried to acquire a token, it would fail with "authentication" just like
			// the previous test. The bypass means the tool runs anyway.
			const ctx = ctxForWiki(
				{
					sitename: 'OAuth-Configured',
					server: 'http://127.0.0.1:1',
					articlepath: '/wiki',
					scriptpath: '/w',
					oauth2ClientId: 'my-client',
				} as never,
				'stdio',
			);

			let toolInvoked = false;
			const bypassTool: Tool<Record<string, never>> = {
				name: toolName,
				description: 'd',
				inputSchema: {},
				annotations: {},
				// add-wiki / remove-wiki / oauth-* are not wiki-scoped, so they skip
				// per-call wiki resolution entirely.
				wikiScoped: false,
				async handle(): Promise<CallToolResult> {
					toolInvoked = true;
					return { content: [{ type: 'text', text: 'ran' }] };
				},
			};

			const result = await dispatch(bypassTool, ctx)({});
			expect(toolInvoked).toBe(true);
			expect(result.isError).toBeUndefined();
			expect((result.content[0] as { text: string }).text).toBe('ran');
		},
	);
});
