import { describe, it, expect, afterEach, vi } from 'vitest';
import {
	capLinesByBytes,
	truncateByBytes,
	DEFAULT_CONTENT_MAX_BYTES,
} from '../../src/results/truncation.ts';

function bytes(lines: string[]): number {
	return Buffer.byteLength(lines.join('\n'), 'utf8');
}

describe('capLinesByBytes', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('returns every line and its byte count when the block fits', () => {
		const lines = ['alpha', 'beta'];

		const capped = capLinesByBytes(lines);

		expect(capped).toEqual({
			lines,
			returnedBytes: bytes(lines),
			totalBytes: bytes(lines),
			truncated: false,
		});
	});

	it('keeps the last line that fits whole when the cut lands on its newline', () => {
		// 'alpha\nbeta' is exactly 10 bytes, so the budget ends on the separator
		// before 'gamma' — the two complete lines before it all survive.
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '10');
		const lines = ['alpha', 'beta', 'gamma'];

		const capped = capLinesByBytes(lines);

		expect(capped.lines).toEqual(['alpha', 'beta']);
		expect(capped.returnedBytes).toBe(10);
		expect(capped.totalBytes).toBe(bytes(lines));
		expect(capped.truncated).toBe(true);
	});

	it('drops only the line the budget cuts into', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '12');
		const lines = ['alpha', 'beta', 'gamma'];

		expect(capLinesByBytes(lines).lines).toEqual(['alpha', 'beta']);
	});

	it('returns a marked, shortened first line rather than nothing', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '8');
		const lines = ['a-very-long-single-line'];

		const capped = capLinesByBytes(lines);

		expect(capped.lines).toEqual(['a-ver…']);
		expect(capped.returnedBytes).toBe(Buffer.byteLength('a-ver…', 'utf8'));
		expect(capped.totalBytes).toBe(bytes(lines));
		expect(capped.truncated).toBe(true);
	});

	it('shortens an oversized first line even when more lines follow', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '8');
		const lines = ['a-very-long-single-line', 'beta'];

		expect(capLinesByBytes(lines).lines).toEqual(['a-ver…']);
	});
});

describe('DEFAULT_CONTENT_MAX_BYTES', () => {
	it('is exported and equals 50000', () => {
		expect(DEFAULT_CONTENT_MAX_BYTES).toBe(50000);
	});
});

describe('MCP_CONTENT_MAX_BYTES env var', () => {
	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it('overrides the default when set to a positive integer', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '100');
		const result = truncateByBytes('x'.repeat(500));
		expect(result.truncated).toBe(true);
		expect(result.returnedBytes).toBe(100);
		expect(result.totalBytes).toBe(500);
	});

	it('falls back to the default when set to a non-numeric value', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', 'nope');
		const result = truncateByBytes('x'.repeat(DEFAULT_CONTENT_MAX_BYTES + 1));
		expect(result.returnedBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
	});

	it('falls back to the default when set to zero or negative', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '0');
		const result = truncateByBytes('x'.repeat(DEFAULT_CONTENT_MAX_BYTES + 1));
		expect(result.returnedBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
	});

	it('falls back to the default when set to an empty string', () => {
		vi.stubEnv('MCP_CONTENT_MAX_BYTES', '');
		const result = truncateByBytes('x'.repeat(DEFAULT_CONTENT_MAX_BYTES + 1));
		expect(result.returnedBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
	});
});

describe('truncateByBytes', () => {
	it('returns the input unchanged when under the limit', () => {
		const result = truncateByBytes('hello', 100);
		expect(result.truncated).toBe(false);
		expect(result.text).toBe('hello');
		expect(result.returnedBytes).toBe(5);
		expect(result.totalBytes).toBe(5);
	});

	it('returns the input unchanged at exactly the limit', () => {
		const result = truncateByBytes('x'.repeat(100), 100);
		expect(result.truncated).toBe(false);
		expect(result.returnedBytes).toBe(100);
		expect(result.totalBytes).toBe(100);
	});

	it('truncates when the input exceeds the limit', () => {
		const input = 'x'.repeat(200);
		const result = truncateByBytes(input, 100);
		expect(result.truncated).toBe(true);
		expect(result.returnedBytes).toBe(100);
		expect(result.totalBytes).toBe(200);
		expect(result.text.length).toBe(100);
	});

	it('defaults to DEFAULT_CONTENT_MAX_BYTES when no limit is passed', () => {
		const input = 'x'.repeat(DEFAULT_CONTENT_MAX_BYTES + 1);
		const result = truncateByBytes(input);
		expect(result.truncated).toBe(true);
		expect(result.returnedBytes).toBe(DEFAULT_CONTENT_MAX_BYTES);
		expect(result.totalBytes).toBe(DEFAULT_CONTENT_MAX_BYTES + 1);
	});

	it('handles a multi-byte UTF-8 character straddling the byte boundary', () => {
		// '漢' is 3 bytes in UTF-8. Build a buffer whose first 100 bytes split
		// the final character across the limit so the slice lands mid-sequence.
		const input = 'x'.repeat(99) + '漢漢';
		const result = truncateByBytes(input, 100);
		expect(result.truncated).toBe(true);
		// Buffer#toString('utf8') replaces the partial trailing byte with U+FFFD;
		// returnedBytes reflects the decoded string's UTF-8 length, which may
		// exceed the raw 100-byte slice but stays bounded by maxBytes + 2 bytes
		// of replacement.
		expect(result.totalBytes).toBe(99 + 6);
		expect(result.returnedBytes).toBeLessThanOrEqual(100 + 2);
		// The returned text must decode cleanly as a string (no thrown decode error)
		expect(typeof result.text).toBe('string');
	});
});
