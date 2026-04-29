import { describe, it, expect } from 'vitest';
import { createToolContext } from '../../src/runtime/createContext.js';
import { logger } from '../../src/runtime/logger.js';

describe('createToolContext', () => {
	it('populates all ToolContext fields', () => {
		const ctx = createToolContext({ logger });
		expect(ctx.mwn).toBeTypeOf('function');
		expect(ctx.wikis).toBeDefined();
		expect(ctx.selection).toBeDefined();
		expect(ctx.uploadDirs).toBeDefined();
		expect(ctx.wikiCache).toBeDefined();
		expect(typeof ctx.wikiCache.invalidate).toBe('function');
		expect(ctx.sections).toBeDefined();
		expect(ctx.edit).toBeDefined();
		expect(ctx.revision).toBeDefined();
		expect(ctx.format).toBeDefined();
		expect(ctx.errors).toBeDefined();
		expect(ctx.logger).toBe(logger);
	});
});
