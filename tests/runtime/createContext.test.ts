import { describe, it, expect } from 'vitest';
import { createToolContext } from '../../src/runtime/createContext.js';
import { createAppState } from '../../src/wikis/state.js';
import { logger } from '../../src/runtime/logger.js';
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
		const ctx = createToolContext({ logger, state });
		expect(ctx.mwn).toBeTypeOf('function');
		expect(ctx.wikis).toBeDefined();
		expect(ctx.selection).toBeDefined();
		expect(ctx.uploadDirs).toBeDefined();
		expect(ctx.wikiCache).toBeDefined();
		expect(typeof ctx.wikiCache.invalidate).toBe('function');
		expect(ctx.licenseCache).toBeDefined();
		expect(ctx.sections).toBeDefined();
		expect(ctx.edit).toBeDefined();
		expect(ctx.revision).toBeDefined();
		expect(ctx.format).toBeDefined();
		expect(ctx.errors).toBeDefined();
		expect(ctx.logger).toBe(logger);
	});
});
