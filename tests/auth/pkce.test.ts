import { describe, expect, it } from 'vitest';
import { randomVerifier, s256 } from '../../src/auth/pkce.js';

describe('pkce.randomVerifier', () => {
	it('returns a string between 43 and 128 chars', () => {
		const v = randomVerifier();
		expect(v.length).toBeGreaterThanOrEqual(43);
		expect(v.length).toBeLessThanOrEqual(128);
	});
	it('uses only the URL-safe RFC 7636 alphabet', () => {
		const v = randomVerifier();
		expect(v).toMatch(/^[A-Za-z0-9\-._~]+$/);
	});
	it('never returns the same value twice in a row', () => {
		expect(randomVerifier()).not.toBe(randomVerifier());
	});
});

describe('pkce.s256', () => {
	it('matches the RFC 7636 appendix B vector', () => {
		// RFC 7636 §4.6 — verifier dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk
		// → challenge E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM
		expect(s256('dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk')).toBe(
			'E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM',
		);
	});
	it('is deterministic', () => {
		const v = 'abcdefghijklmnopqrstuvwxyz0123456789-._~ABCDEFG';
		expect(s256(v)).toBe(s256(v));
	});
});
