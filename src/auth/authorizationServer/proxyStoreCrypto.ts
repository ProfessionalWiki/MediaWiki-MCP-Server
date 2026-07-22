import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'node:crypto';

// Envelope: [version(1)][iv(12)][tag(16)][ciphertext]. AES-256-GCM.
const VERSION = 1;
const IV_LEN = 12;
const TAG_LEN = 16;
const KEY_LEN = 32;
const HKDF_INFO = Buffer.from('proxy-store-v1', 'utf8');

/**
 * Derive the store-encryption key from the proxy's JWT signing key. Domain-separated
 * from the signing use by the HKDF `info` label, so the two never collide even though
 * they share one secret. Deterministic: the same signing key always yields the same
 * key, so a restart can decrypt what a prior run wrote.
 */
export function deriveKey(signingKey: string): Buffer {
	const derived = hkdfSync(
		'sha256',
		Buffer.from(signingKey, 'utf8'),
		Buffer.alloc(0),
		HKDF_INFO,
		KEY_LEN,
	);
	return Buffer.from(derived);
}

export function encrypt(key: Buffer, plaintext: Buffer): Buffer {
	const iv = randomBytes(IV_LEN);
	const cipher = createCipheriv('aes-256-gcm', key, iv);
	cipher.setAAD(Buffer.from([VERSION]));
	const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
	const tag = cipher.getAuthTag();
	return Buffer.concat([Buffer.from([VERSION]), iv, tag, ct]);
}

export function decrypt(key: Buffer, blob: Buffer): Buffer {
	if (blob.length < 1 + IV_LEN + TAG_LEN || blob[0] !== VERSION) {
		throw new Error('unrecognized proxy store envelope');
	}
	const iv = blob.subarray(1, 1 + IV_LEN);
	const tag = blob.subarray(1 + IV_LEN, 1 + IV_LEN + TAG_LEN);
	const ct = blob.subarray(1 + IV_LEN + TAG_LEN);
	const decipher = createDecipheriv('aes-256-gcm', key, iv);
	decipher.setAAD(Buffer.from([VERSION]));
	decipher.setAuthTag(tag);
	return Buffer.concat([decipher.update(ct), decipher.final()]);
}
