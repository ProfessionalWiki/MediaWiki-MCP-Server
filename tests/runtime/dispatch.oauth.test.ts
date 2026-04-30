// tests/runtime/dispatch.oauth.test.ts
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import type { Tool } from '../../src/runtime/tool.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.js';
import { useTempTokenStore } from '../helpers/tempTokenStore.js';
import { getRuntimeToken } from '../../src/transport/requestContext.js';
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

		const ctx = fakeContext({
			transport: 'stdio',
			selection: {
				getCurrent: () => ({
					key: 'test-wiki',
					config: {
						sitename: 'Test',
						server: fakeAs.url,
						articlepath: '/wiki',
						scriptpath: '/w',
						oauth2ClientId: 'my-client',
						tags: null,
					} as never,
				}),
				setCurrent: () => {},
				reset: () => {},
			},
		});

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		const text = (result.content[0] as { text: string }).text;
		expect(text).toMatch(/^access-CODE-/);
	});

	it('stdio without oauth2ClientId: does not call acquireToken / open', async () => {
		fakeAs = await startFakeAs();

		const ctx = fakeContext({
			transport: 'stdio',
			// default fakeContext selection has no oauth2ClientId
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

		const ctx = fakeContext({
			transport: 'http',
			selection: {
				getCurrent: () => ({
					key: 'test-wiki',
					config: {
						sitename: 'Test',
						server: fakeAs.url,
						articlepath: '/wiki',
						scriptpath: '/w',
						oauth2ClientId: 'my-client',
						tags: null,
					} as never,
				}),
				setCurrent: () => {},
				reset: () => {},
			},
		});

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		// HTTP transport: no token acquired, getRuntimeToken() returns undefined
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe('');
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('acquireToken failure: tool is NOT invoked; returns authentication error', async () => {
		// Point server at a non-existent URL so acquireToken's metadata fetch fails.
		const ctx = fakeContext({
			transport: 'stdio',
			selection: {
				getCurrent: () => ({
					key: 'broken-wiki',
					config: {
						sitename: 'Broken',
						server: 'http://127.0.0.1:1', // nothing listening here
						articlepath: '/wiki',
						scriptpath: '/w',
						oauth2ClientId: 'my-client',
						tags: null,
					} as never,
				}),
				setCurrent: () => {},
				reset: () => {},
			},
		});

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
});
