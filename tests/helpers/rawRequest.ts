import { vi } from 'vitest';
import type { ToolContext } from '../../src/runtime/context.ts';
import { createMockMwn, type MockMwn } from './mock-mwn.ts';
import { contextOn } from './fakeContext.ts';
import { httpError } from './httpError.ts';

/** A tool context whose wiki answers every raw request with `data`. */
export function contextReturning(data: unknown): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({ rawRequest: vi.fn().mockResolvedValue({ data }) });
	return { mock, ctx: contextOn(mock) };
}

/** The URL of the first raw request the tool sent. */
export function requestedUrl(mock: MockMwn): URL {
	return new URL((mock.rawRequest.mock.calls[0][0] as { url: string }).url);
}

/** A tool context whose wiki hands out a CSRF token and answers every raw request with `data`. */
export function writeContextReturning(data: unknown): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockResolvedValue({ data }),
	});
	return { mock, ctx: contextOn(mock) };
}

/** A tool context whose wiki hands out a CSRF token and answers successive raw requests with `data`, in turn. */
export function writeContextReturningInTurn(...data: unknown[]): {
	mock: MockMwn;
	ctx: ToolContext;
} {
	const rawRequest = vi.fn();
	for (const answer of data) {
		rawRequest.mockResolvedValueOnce({ data: answer });
	}
	const mock = createMockMwn({ getCsrfToken: vi.fn().mockResolvedValue('tok'), rawRequest });
	return { mock, ctx: contextOn(mock) };
}

interface SentRequest {
	url: string;
	method: string;
	headers: Record<string, string>;
	data?: string;
	body: Record<string, unknown>;
}

/** Every raw request the tool sent, in order, each with its JSON body parsed. */
export function sentRequests(mock: MockMwn): SentRequest[] {
	return mock.rawRequest.mock.calls.map(([call]) => {
		const request = call as Omit<SentRequest, 'body'>;
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON body the tool sent
		const body =
			request.data === undefined ? {} : (JSON.parse(request.data) as Record<string, unknown>);
		return { ...request, body };
	});
}

/** The first raw request the tool sent, with its JSON body parsed. */
export function sentRequest(mock: MockMwn): SentRequest {
	return sentRequests(mock)[0];
}

/** A tool context whose wiki hands out a CSRF token and fails every raw request with HTTP `status` and `body`. */
export function contextFailingWith(
	status: number,
	body: unknown,
): { mock: MockMwn; ctx: ToolContext } {
	const mock = createMockMwn({
		getCsrfToken: vi.fn().mockResolvedValue('tok'),
		rawRequest: vi.fn().mockRejectedValue(httpError(status, body)),
	});
	return { mock, ctx: contextOn(mock) };
}
