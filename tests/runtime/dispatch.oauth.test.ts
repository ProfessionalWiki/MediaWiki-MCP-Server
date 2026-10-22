// tests/runtime/dispatch.oauth.test.ts
import type { CallToolResult } from '@modelcontextprotocol/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import type { Tool } from '../../src/runtime/tool.ts';
import type { SharedContext } from '../../src/runtime/context.ts';
import { listWikis } from '../../src/tools/list-wikis.ts';
import { fakeContext, ctxForWiki, ctxForWikis } from '../helpers/fakeContext.ts';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.ts';
import { fakeBrowserDriver } from '../helpers/fakeBrowserDriver.ts';
import { useTempTokenStore } from '../helpers/tempTokenStore.ts';
import { createTokenStore } from '../../src/auth/tokenStore.ts';
import { getRuntimeToken } from '../../src/runtime/requestContext.ts';
import { _resetMetadataCacheForTesting } from '../../src/auth/metadata.ts';
import { _resetBrowserAuthDedupForTesting } from '../../src/auth/browserAuth.ts';
import { _resetRefreshDedupForTesting } from '../../src/auth/tokenRefresh.ts';

vi.mock('open', () => ({ default: vi.fn() }));
import openMod from 'open';
import { fakeAuthPolicy } from '../helpers/fakeAuthPolicy.ts';

useTempTokenStore();

let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
	_resetBrowserAuthDedupForTesting();
	_resetRefreshDedupForTesting();
	vi.clearAllMocks();
});

/** A dummy tool that returns the token its call may send to the wiki it resolved. */
const tokenCaptureTool: Tool<Record<string, never>> = {
	name: 'dummy',
	description: 'd',
	inputSchema: {},
	annotations: { readOnlyHint: true },
	async handle(_args, ctx): Promise<CallToolResult> {
		return { content: [{ type: 'text', text: getRuntimeToken(ctx.wiki.key) ?? '' }] };
	},
};

describe('dispatch OAuth integration', () => {
	it('stdio + oauth2ClientId: acquires a token and the tool runs with it', async () => {
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

	it('stdio + oauth2ClientId: binds the token to the wiki it was acquired for', async () => {
		fakeAs = await startFakeAs();
		vi.mocked(openMod).mockImplementation(
			fakeBrowserDriver(fakeAs.url, 'consent') as typeof openMod,
		);
		// The OAuth wiki is not the default, so a token bound to the default would show.
		const ctx = ctxForWikis(
			{
				home: {
					sitename: 'Home',
					server: 'https://home.example',
					articlepath: '/wiki',
					scriptpath: '/w',
				},
				'wiki-key': {
					sitename: 'Test',
					server: fakeAs.url,
					articlepath: '/wiki',
					scriptpath: '/w',
					oauth2ClientId: 'my-client',
				},
			},
			'home',
			'stdio',
		);
		const seen: { oauthWiki?: string; defaultWiki?: string } = {};
		const captureTool: Tool<Record<string, never>> = {
			name: 'binding-capture',
			description: 'd',
			inputSchema: {},
			annotations: { readOnlyHint: true },
			async handle(): Promise<CallToolResult> {
				seen.oauthWiki = getRuntimeToken('wiki-key');
				seen.defaultWiki = getRuntimeToken('home');
				return { content: [{ type: 'text', text: 'ran' }] };
			},
		};

		await dispatch(captureTool, ctx)({ wiki: 'wiki-key' } as never);

		expect(seen.oauthWiki).toMatch(/^access-CODE-/);
		expect(seen.defaultWiki).toBeUndefined();
		const stored = (await createTokenStore().read()).tokens;
		expect(stored['wiki-key']).toBeDefined();
		expect(stored.home).toBeUndefined();
	});

	it('stdio without oauth2ClientId: does not call acquireToken / open', async () => {
		fakeAs = await startFakeAs();

		const ctx = fakeContext({
			auth: fakeAuthPolicy({ transport: 'stdio' }),
			// the default fakeContext wiki has no oauth2ClientId
		});

		const result = await dispatch(tokenCaptureTool, ctx)({});
		expect(result.isError).toBeUndefined();
		// No token acquired, so the call holds none
		const text = (result.content[0] as { text: string }).text;
		expect(text).toBe('');
		expect(vi.mocked(openMod)).not.toHaveBeenCalled();
	});

	it('http + oauth2ClientId with no token: capability guard rejects, no acquireToken / open', async () => {
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
		// HTTP transport: an OAuth-only wiki with no usable token is rejected
		// up front by the capability guard with an authentication error; the
		// dispatcher never reaches the OAuth gate, so open() is never called.
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('requires an authenticated user');
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
			annotations: { readOnlyHint: true },
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

	describe('a wiki whose OAuth sign-in cannot complete', () => {
		// Nothing listens at this server, so a sign-in attempt fails with an
		// authentication error, as in the previous test.
		const unreachableOauthWiki = (): ReturnType<typeof ctxForWiki> =>
			ctxForWiki(
				{
					sitename: 'OAuth-Configured',
					server: 'http://127.0.0.1:1',
					articlepath: '/wiki',
					scriptpath: '/w',
					oauth2ClientId: 'my-client',
				} as never,
				'stdio',
			);

		it('runs a tool that is not wiki-scoped without OAuth sign-in', async () => {
			const serverLocalTool: Tool<Record<string, never>, SharedContext> = {
				name: 'server-local',
				description: 'd',
				inputSchema: {},
				annotations: { readOnlyHint: true },
				wikiScoped: false,
				async handle(): Promise<CallToolResult> {
					return { content: [{ type: 'text', text: 'ran' }] };
				},
			};

			const result = await dispatch(serverLocalTool, unreachableOauthWiki())({});

			expect(result.isError).toBeUndefined();
			expect((result.content[0] as { text: string }).text).toBe('ran');
		});

		it('runs list-wikis without OAuth sign-in', async () => {
			const result = await dispatch(listWikis, unreachableOauthWiki())({});

			expect(result.isError).toBeUndefined();
			expect(JSON.stringify(result.structuredContent)).toContain('wiki-key');
		});
	});
});
