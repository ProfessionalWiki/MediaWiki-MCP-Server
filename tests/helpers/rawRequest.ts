import { vi } from 'vitest';
import type { ToolContext } from '../../src/runtime/context.ts';
import { createMockMwn, type MockMwn } from './mock-mwn.ts';
import { fakeContext } from './fakeContext.ts';

/** A tool context whose wiki answers every raw request with `data`. */
export function contextReturning(data: unknown): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data }) });
	return { mock, ctx: fakeContext({ mwn: async () => mock as never }) };
}

/** The URL of the first raw request the tool sent. */
export function requestedUrl(mock: MockMwn): URL {
	return new URL((mock.rawRequest.mock.calls[0][0] as { url: string }).url);
}
