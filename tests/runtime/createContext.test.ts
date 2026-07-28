import { describe, it, expect } from 'vitest';
import { createToolContext } from '../../src/runtime/createContext.js';
import { createAppState, type AppState } from '../../src/wikis/state.js';
import { logger } from '../../src/runtime/logger.js';
import { withRequestFields } from '../../src/runtime/requestContext.js';
import type { Config } from '../../src/config/loadConfig.js';

const testConfig: Config = {
	defaultWiki: 'w',
	wikis: {
		w: {
			sitename: 'Test',
			server: 'https://test.wiki',
			articlepath: '/wiki',
			scriptpath: '/w',
			token: null,
			username: null,
			password: null,
		},
	},
	uploadDirs: [],
};

describe('createToolContext', () => {
	it('populates all ToolContext fields', () => {
		const state = createAppState(testConfig);
		const ctx = createToolContext({ logger, state, transport: 'stdio' });
		expect(ctx.mwn).toBeTypeOf('function');
		expect(ctx.wikis).toBeDefined();
		expect(ctx.activeWiki).toBeDefined();
		expect(ctx.uploadDirs).toBeDefined();
		expect(ctx.wikiCache).toBeDefined();
		expect(typeof ctx.wikiCache.invalidate).toBe('function');
		expect(ctx.siteInfoCache).toBeDefined();
		expect(ctx.wikiProbe).toBeDefined();
		expect(ctx.sections).toBeDefined();
		expect(ctx.edit).toBeDefined();
		expect(ctx.revision).toBeDefined();
		expect(ctx.format).toBeDefined();
		expect(ctx.errors).toBeDefined();
		expect(ctx.logger).toBe(logger);
		expect(ctx.transport).toBe('stdio');
	});

	it('applies the request cancellation signal to the mwn instance it hands out', async () => {
		const calls: { signal?: AbortSignal }[] = [];
		const bot = {
			async rawRequest(options: { signal?: AbortSignal }): Promise<unknown> {
				calls.push(options);
				return {};
			},
		};
		const state = {
			...createAppState(testConfig),
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stub covering only the surface under test
			mwnProvider: { get: async (): Promise<unknown> => bot } as unknown as AppState['mwnProvider'],
		};
		const ctx = createToolContext({ logger, state, transport: 'stdio' });
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, async () => {
			const scoped = await ctx.mwn();
			await scoped.rawRequest({ url: 'https://test.wiki/w/api.php' });
		});

		expect(calls[0]?.signal).toBe(controller.signal);
	});

	it('hands out the bare instance when no request scope is active', async () => {
		const bot = {
			async rawRequest(): Promise<unknown> {
				return {};
			},
		};
		const state = {
			...createAppState(testConfig),
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- stub covering only the surface under test
			mwnProvider: { get: async (): Promise<unknown> => bot } as unknown as AppState['mwnProvider'],
		};
		const ctx = createToolContext({ logger, state, transport: 'stdio' });

		expect(await ctx.mwn()).toBe(bot);
	});
});
