import { describe, it, expect } from 'vitest';
import { evaluateBearerGuard } from '../../src/transport/bearerGuard.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

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
		expect(evaluateBearerGuard({}, {})).toEqual({ kind: 'ok' });
	});

	it('returns ok when no wiki has credentials', () => {
		const wikis = { a: wiki(), b: wiki({ token: null }) };
		expect(evaluateBearerGuard(wikis, {})).toEqual({ kind: 'ok' });
	});

	it('returns block when a wiki has a token and the override env is unset', () => {
		const wikis = { a: wiki({ token: 'abc' }) };
		expect(evaluateBearerGuard(wikis, {})).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});

	it('returns block when a wiki has bot-password credentials', () => {
		const wikis = { a: wiki({ username: 'u', password: 'p' }) };
		expect(evaluateBearerGuard(wikis, {})).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});

	it('returns override when MCP_ALLOW_STATIC_FALLBACK is exactly "true"', () => {
		const wikis = { a: wiki({ token: 'abc' }) };
		expect(evaluateBearerGuard(wikis, { MCP_ALLOW_STATIC_FALLBACK: 'true' })).toEqual({
			kind: 'override',
			wikis: ['a'],
		});
	});

	it.each(['TRUE', '1', 'yes', ' true ', ''])(
		'returns block when MCP_ALLOW_STATIC_FALLBACK is %p (not exactly "true")',
		(value) => {
			const wikis = { a: wiki({ token: 'abc' }) };
			expect(evaluateBearerGuard(wikis, { MCP_ALLOW_STATIC_FALLBACK: value })).toEqual({
				kind: 'block',
				wikis: ['a'],
			});
		},
	);

	it('lists only credentialed wikis, in insertion order', () => {
		const wikis = {
			a: wiki(),
			b: wiki({ token: 'abc' }),
			c: wiki(),
			d: wiki({ username: 'u', password: 'p' }),
		};
		expect(evaluateBearerGuard(wikis, {})).toEqual({
			kind: 'block',
			wikis: ['b', 'd'],
		});
	});

	it('returns ok regardless of MCP_ALLOW_STATIC_FALLBACK when no wiki has credentials', () => {
		expect(evaluateBearerGuard({}, { MCP_ALLOW_STATIC_FALLBACK: 'true' })).toEqual({
			kind: 'ok',
		});
	});

	it('returns block for a wiki with an exec-backed token when MCP_ALLOW_STATIC_FALLBACK is unset', () => {
		const execToken = { exec: { command: 'op', args: ['read', 'x'] } };
		const wikis = { a: wiki({ token: execToken }) };
		expect(evaluateBearerGuard(wikis, {})).toEqual({
			kind: 'block',
			wikis: ['a'],
		});
	});
});
