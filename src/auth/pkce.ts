import { createHash, randomBytes } from 'node:crypto';

/**
 * Generate an RFC 7636 §4.1 code_verifier: 43–128 chars from the URL-safe
 * alphabet [A-Z][a-z][0-9]-._~. We use 32 random bytes (256 bits) base64url-
 * encoded, which yields 43 chars — the spec minimum and plenty of entropy.
 */
export function randomVerifier(): string {
	return base64url(randomBytes(32));
}

/**
 * RFC 7636 §4.2 code_challenge = BASE64URL-ENCODE(SHA256(verifier)).
 */
export function s256(verifier: string): string {
	return base64url(createHash('sha256').update(verifier, 'ascii').digest());
}

function base64url(buf: Buffer): string {
	return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
