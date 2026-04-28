import { describe, it, expect } from 'vitest';
import {
	runtimeTokenStore,
	getRuntimeToken,
	getSessionId,
} from '../../src/transport/requestContext.js';

describe('requestContext', () => {
	it('returns undefined outside a run', () => {
		expect(getRuntimeToken()).toBeUndefined();
	});

	it('returns the token inside a run', () => {
		runtimeTokenStore.run({ runtimeToken: 'abc' }, () => {
			expect(getRuntimeToken()).toBe('abc');
		});
	});

	it('returns undefined when runtimeToken is not set in the context', () => {
		runtimeTokenStore.run({}, () => {
			expect(getRuntimeToken()).toBeUndefined();
		});
	});

	it('inner run overrides outer token', () => {
		runtimeTokenStore.run({ runtimeToken: 'outer' }, () => {
			expect(getRuntimeToken()).toBe('outer');
			runtimeTokenStore.run({ runtimeToken: 'inner' }, () => {
				expect(getRuntimeToken()).toBe('inner');
			});
			expect(getRuntimeToken()).toBe('outer');
		});
	});

	it('isolates concurrent runs', async () => {
		const results: string[] = [];

		await Promise.all([
			runtimeTokenStore.run({ runtimeToken: 'token-a' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(`a:${getRuntimeToken()}`);
			}),
			runtimeTokenStore.run({ runtimeToken: 'token-b' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`b:${getRuntimeToken()}`);
			}),
		]);

		expect(results).toContain('a:token-a');
		expect(results).toContain('b:token-b');
	});
});

describe('getSessionId', () => {
	it('returns undefined outside any store context', () => {
		expect(getSessionId()).toBeUndefined();
	});

	it('returns the session id provided to the store', () => {
		runtimeTokenStore.run({ sessionId: 'abc123' }, () => {
			expect(getSessionId()).toBe('abc123');
		});
	});

	it('is independent of runtimeToken', () => {
		runtimeTokenStore.run({ runtimeToken: 't', sessionId: 's' }, () => {
			expect(getRuntimeToken()).toBe('t');
			expect(getSessionId()).toBe('s');
		});
	});

	it('returns undefined when only runtimeToken is set', () => {
		runtimeTokenStore.run({ runtimeToken: 't' }, () => {
			expect(getSessionId()).toBeUndefined();
		});
	});

	it('inner run overrides outer session id', () => {
		runtimeTokenStore.run({ sessionId: 'outer' }, () => {
			expect(getSessionId()).toBe('outer');
			runtimeTokenStore.run({ sessionId: 'inner' }, () => {
				expect(getSessionId()).toBe('inner');
			});
			expect(getSessionId()).toBe('outer');
		});
	});

	it('isolates concurrent session ids', async () => {
		const results: string[] = [];

		await Promise.all([
			runtimeTokenStore.run({ sessionId: 'session-a' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 10));
				results.push(`a:${getSessionId()}`);
			}),
			runtimeTokenStore.run({ sessionId: 'session-b' }, async () => {
				await new Promise((resolve) => setTimeout(resolve, 5));
				results.push(`b:${getSessionId()}`);
			}),
		]);

		expect(results).toContain('a:session-a');
		expect(results).toContain('b:session-b');
	});
});
