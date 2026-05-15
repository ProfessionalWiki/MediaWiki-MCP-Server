import { describe, it, expect } from 'vitest';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import type { Tool } from '../../src/runtime/tool.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getRequestWiki } from '../../src/transport/requestContext.js';

// A minimal wiki-scoped tool that reports the wiki it ran against.
const probe: Tool<Record<string, never>> = {
	name: 'probe',
	description: 'test probe',
	inputSchema: {},
	annotations: {} as never,
	async handle(_args, ctx): Promise<CallToolResult> {
		return ctx.format.ok({ ranAgainst: getRequestWiki() });
	},
};

function ranAgainst(result: CallToolResult): unknown {
	return (result.structuredContent as { ranAgainst?: unknown }).ranAgainst;
}

describe('dispatch wiki resolution', () => {
	it('runs against the wiki named in the wiki argument', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'fr.wikipedia.org' } as never);
		expect(ranAgainst(result)).toBe('fr.wikipedia.org');
	});

	it('runs against the default wiki when wiki is omitted', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({} as never);
		expect(ranAgainst(result)).toBe('test-wiki');
	});

	it('accepts an mcp://wikis/ URI', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'mcp://wikis/fr.wikipedia.org' } as never);
		expect(ranAgainst(result)).toBe('fr.wikipedia.org');
	});

	it('returns invalid_input for an unknown wiki', async () => {
		const ctx = fakeContext();
		const result = await dispatch(probe, ctx)({ wiki: 'nope.example' } as never);
		expect(result.isError).toBe(true);
		expect(JSON.stringify(result.content)).toContain('not found');
	});

	it('isolates concurrent calls targeting different wikis', async () => {
		const ctx = fakeContext();
		const [a, b] = await Promise.all([
			dispatch(probe, ctx)({ wiki: 'fr.wikipedia.org' } as never),
			dispatch(probe, ctx)({ wiki: 'de.wikipedia.org' } as never),
		]);
		expect(ranAgainst(a)).toBe('fr.wikipedia.org');
		expect(ranAgainst(b)).toBe('de.wikipedia.org');
	});
});
