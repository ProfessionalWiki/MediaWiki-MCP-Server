import { randomBytes } from 'node:crypto';
import { describe, it, expect } from 'vitest';
import {
	deriveKey,
	encrypt,
	decrypt,
} from '../../../src/auth/authorizationServer/proxyStoreCrypto.js';

describe('proxyStoreCrypto', () => {
	const key = deriveKey('x'.repeat(32));

	it('round-trips plaintext', () => {
		const pt = Buffer.from('hello {"a":1}', 'utf8');
		expect(decrypt(key, encrypt(key, pt)).toString('utf8')).toBe('hello {"a":1}');
	});

	it('round-trips empty plaintext', () => {
		expect(decrypt(key, encrypt(key, Buffer.alloc(0))).length).toBe(0);
	});

	it('derives a deterministic key, distinct per signing key', () => {
		expect(deriveKey('k'.repeat(40)).equals(deriveKey('k'.repeat(40)))).toBe(true);
		expect(deriveKey('a'.repeat(40)).equals(deriveKey('b'.repeat(40)))).toBe(false);
	});

	it('fails to decrypt with the wrong key', () => {
		const blob = encrypt(key, Buffer.from('secret'));
		expect(() => decrypt(deriveKey('y'.repeat(32)), blob)).toThrow();
	});

	it('fails to decrypt a tampered ciphertext', () => {
		const blob = encrypt(key, Buffer.from('secret'));
		blob[blob.length - 1] ^= 0xff;
		expect(() => decrypt(key, blob)).toThrow();
	});

	it('rejects an unrecognized envelope', () => {
		expect(() => decrypt(key, Buffer.from([9, 9, 9]))).toThrow('unrecognized');
	});

	it('rejects a correct-length blob with an unknown version byte', () => {
		// 1 (version) + 12 (iv) + 16 (tag) = 29 bytes minimum; use a bad version byte.
		const blob = Buffer.concat([Buffer.from([9]), randomBytes(40)]);
		expect(() => decrypt(key, blob)).toThrow('unrecognized');
	});
});
