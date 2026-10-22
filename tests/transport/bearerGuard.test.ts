import { describe, it, expect } from 'vitest';
import { evaluateBearerGuard } from '../../src/transport/bearerGuard.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';

function wiki(overrides: Partial<WikiConfig> = {}): WikiConfig {
	return {
		sitename: 'Example',
		server: 'https://example.org',
		articlepath: '/wiki',
		scriptpath: '/w',
		...overrides,
	};
}

describe('evaluateBearerGuard', () => {
	it('returns ok when there are no wikis', () => {
		expect(evaluateBearerGuard({}, false)).toEqual({ kind: 'ok' });
	});

	it('returns ok when no wiki has credentials', () => {
		const wikis = { a: wiki(), b: wiki({ token: null }) };
		expect(evaluateBearerGuard(wikis, false)).toEqual({ kind: 'ok' });
	});

	it('returns block when a wiki has a token and the static fallback is off', () => {
		const wikis = { a: wiki({ token: 'abc' }) };
		expect(evaluateBearerGuard(wikis, false)).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});

	it('returns block when a wiki has bot-password credentials', () => {
		const wikis = { a: wiki({ username: 'u', password: 'p' }) };
		expect(evaluateBearerGuard(wikis, false)).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});

	it('returns override when the static fallback is on', () => {
		const wikis = { a: wiki({ token: 'abc' }) };
		expect(evaluateBearerGuard(wikis, true)).toEqual({
			kind: 'override',
			wikis: ['a'],
		});
	});

	it('lists only credentialed wikis, in insertion order', () => {
		const wikis = {
			a: wiki(),
			b: wiki({ token: 'abc' }),
			c: wiki(),
			d: wiki({ username: 'u', password: 'p' }),
		};
		expect(evaluateBearerGuard(wikis, false)).toEqual({
			kind: 'block',
			wikis: ['b', 'd'],
		});
	});

	it('returns ok regardless of the static fallback when no wiki has credentials', () => {
		expect(evaluateBearerGuard({}, true)).toEqual({
			kind: 'ok',
		});
	});

	it('returns block for a wiki with an exec-backed token when the static fallback is off', () => {
		const execToken = { exec: { command: 'op', args: ['read', 'x'] } };
		const wikis = { a: wiki({ token: execToken }) };
		expect(evaluateBearerGuard(wikis, false)).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});
});
