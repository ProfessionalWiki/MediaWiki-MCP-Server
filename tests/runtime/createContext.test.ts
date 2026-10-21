import { describe, it, expect } from 'vitest';
import { createSharedContext } from '../../src/runtime/createContext.ts';
import { createAppState, type AppState } from '../../src/wikis/state.ts';
import { logger } from '../../src/runtime/logger.ts';
import { withRequestFields } from '../../src/runtime/requestContext.ts';
import { callDeadline } from '../../src/runtime/callDeadline.ts';
import type { Config } from '../../src/config/loadConfig.ts';

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

function contextOverStubbedBot(): {
	ctx: ReturnType<typeof createSharedContext>;
	calls: { signal?: AbortSignal }[];
} {
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
	return { ctx: createSharedContext({ logger, state, transport: 'stdio' }), calls };
}

describe('createSharedContext', () => {
	it('populates all SharedContext fields', () => {
		const state = createAppState(testConfig);
		const ctx = createSharedContext({ logger, state, transport: 'stdio' });
		expect(ctx.mwnFor).toBeTypeOf('function');
		expect(ctx.editFor).toBeTypeOf('function');
		expect(ctx.wikis).toBeDefined();
		expect(ctx.activeWiki).toBeDefined();
		expect(ctx.uploadDirs).toBeDefined();
		expect(ctx.wikiCache).toBeDefined();
		expect(typeof ctx.wikiCache.invalidate).toBe('function');
		expect(ctx.wikiProbe).toBeDefined();
		expect(ctx.sections).toBeDefined();
		expect(ctx.revision).toBeDefined();
		expect(ctx.format).toBeDefined();
		expect(ctx.errors).toBeDefined();
		expect(ctx.logger).toBe(logger);
		expect(ctx.transport).toBe('stdio');
	});

	it('applies the request cancellation signal to the mwn instance it hands out', async () => {
		const { ctx, calls } = contextOverStubbedBot();
		const controller = new AbortController();

		await withRequestFields({ signal: controller.signal }, async () => {
			const scoped = await ctx.mwnFor('w');
			await scoped.rawRequest({ url: 'https://test.wiki/w/api.php' });
		});

		expect(calls[0]?.signal?.aborted).toBe(false);
		controller.abort();
		expect(calls[0]?.signal?.aborted).toBe(true);
	});

	it('spends one budget across every acquisition in the same call', async () => {
		const { ctx, calls } = contextOverStubbedBot();

		await withRequestFields({ deadline: callDeadline(20, 'calling') }, async () => {
			await (await ctx.mwnFor('w')).rawRequest({ url: 'https://test.wiki/w/api.php' });
			await new Promise((resolve) => setTimeout(resolve, 40));
			await (await ctx.mwnFor('w')).rawRequest({ url: 'https://test.wiki/w/api.php' });
		});

		// A budget armed per acquisition would let a tool that acquires twice spend two.
		expect(calls[0]?.signal?.aborted).toBe(true);
		expect(calls[1]?.signal?.aborted).toBe(true);
	});

	it('bounds calls made outside any request scope', async () => {
		const { ctx, calls } = contextOverStubbedBot();

		await (await ctx.mwnFor('w')).rawRequest({ url: 'https://test.wiki/w/api.php' });

		// Startup reconciliation, the wiki resources and the readiness probe reach
		// the wiki with no MCP request around them.
		expect(calls[0]?.signal).toBeDefined();
	});
});
