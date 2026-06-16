import { SignJWT, jwtVerify, type JWTVerifyOptions } from 'jose';

const enc = (k: string): Uint8Array => new TextEncoder().encode(k);
const ALG = 'HS256';
const VERIFY_OPTS = { algorithms: [ALG] } satisfies JWTVerifyOptions;

export async function mintAccessToken(a: {
	issuer: string;
	signingKey: string;
	upstreamTokenId: string;
	ttlMs: number;
	scopes: string[];
}): Promise<string> {
	return new SignJWT({ scope: a.scopes.join(' '), typ: 'access' })
		.setProtectedHeader({ alg: ALG })
		.setIssuer(a.issuer)
		.setAudience(a.issuer)
		.setJti(a.upstreamTokenId)
		.setIssuedAt()
		.setExpirationTime(new Date(Date.now() + a.ttlMs))
		.sign(enc(a.signingKey));
}

export async function verifyAccessToken(
	token: string,
	o: { issuer: string; signingKey: string },
): Promise<{ upstreamTokenId: string; scopes: string[] }> {
	const { payload } = await jwtVerify(token, enc(o.signingKey), {
		...VERIFY_OPTS,
		issuer: o.issuer,
		audience: o.issuer,
		requiredClaims: ['exp'],
	});
	if (payload.typ !== 'access' || typeof payload.jti !== 'string') {
		throw new Error('not an access token');
	}
	const scope = typeof payload.scope === 'string' ? payload.scope : '';
	return {
		upstreamTokenId: payload.jti,
		scopes: scope.split(' ').filter(Boolean),
	};
}

export async function mintRefreshToken(a: {
	issuer: string;
	signingKey: string;
	upstreamTokenId: string;
	ttlMs: number;
}): Promise<string> {
	return new SignJWT({ typ: 'refresh' })
		.setProtectedHeader({ alg: ALG })
		.setIssuer(a.issuer)
		.setAudience(a.issuer)
		.setJti(a.upstreamTokenId)
		.setIssuedAt()
		.setExpirationTime(new Date(Date.now() + a.ttlMs))
		.sign(enc(a.signingKey));
}

export async function verifyRefreshToken(
	token: string,
	o: { issuer: string; signingKey: string },
): Promise<{ upstreamTokenId: string }> {
	const { payload } = await jwtVerify(token, enc(o.signingKey), {
		...VERIFY_OPTS,
		issuer: o.issuer,
		audience: o.issuer,
		requiredClaims: ['exp'],
	});
	if (payload.typ !== 'refresh' || typeof payload.jti !== 'string') {
		throw new Error('not a refresh token');
	}
	return { upstreamTokenId: payload.jti };
}

export async function signConsent(a: {
	clientId: string;
	redirectHost: string;
	wiki: string;
	ttlMs: number;
	signingKey: string;
}): Promise<string> {
	return new SignJWT({ cid: a.clientId, rh: a.redirectHost, wiki: a.wiki, typ: 'consent' })
		.setProtectedHeader({ alg: ALG })
		.setIssuedAt()
		.setExpirationTime(new Date(Date.now() + a.ttlMs))
		.sign(enc(a.signingKey));
}

export async function verifyConsent(
	cookie: string,
	o: { clientId: string; redirectHost: string; wiki: string; signingKey: string },
): Promise<boolean> {
	try {
		const { payload } = await jwtVerify(cookie, enc(o.signingKey), VERIFY_OPTS);
		return (
			payload.typ === 'consent' &&
			payload.cid === o.clientId &&
			payload.rh === o.redirectHost &&
			payload.wiki === o.wiki
		);
	} catch {
		return false;
	}
}
