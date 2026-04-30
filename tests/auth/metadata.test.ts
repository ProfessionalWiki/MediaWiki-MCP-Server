// tests/auth/metadata.test.ts
import { afterEach, describe, expect, it } from 'vitest';
import {
	fetchMetadata,
	MetadataError,
	_resetMetadataCacheForTesting,
} from '../../src/auth/metadata.js';
import { startFakeAs, type FakeAsHandle } from '../helpers/fakeAuthorizationServer.js';

let fakeAs: FakeAsHandle;

afterEach(async () => {
	await fakeAs?.close();
	_resetMetadataCacheForTesting();
});

function wikiPointingAt(handle: FakeAsHandle) {
	return { server: handle.url, scriptpath: '/w' };
}

describe('fetchMetadata', () => {
	it('returns origin-rooted metadata when present', async () => {
		fakeAs = await startFakeAs({ wellKnown: 'origin' });
		const md = await fetchMetadata('k', wikiPointingAt(fakeAs));
		expect(md.source).toBe('well-known');
		expect(md.authorization_endpoint).toContain('/oauth2/authorize');
		expect(md.token_endpoint).toContain('/oauth2/access_token');
		expect(md.synthesized).toBe(false);
	});

	it('falls through to the path-aware probe when origin-rooted 404s', async () => {
		fakeAs = await startFakeAs({ wellKnown: 'pathed' });
		const md = await fetchMetadata('k', wikiPointingAt(fakeAs));
		expect(md.source).toBe('well-known-pathed');
	});

	it('synthesises endpoints when both probes 404', async () => {
		fakeAs = await startFakeAs({ wellKnown: 'absent' });
		const md = await fetchMetadata('k', wikiPointingAt(fakeAs));
		expect(md.source).toBe('synthesized');
		expect(md.synthesized).toBe(true);
		expect(md.authorization_endpoint).toBe(`${fakeAs.url}/w/rest.php/oauth2/authorize`);
		expect(md.token_endpoint).toBe(`${fakeAs.url}/w/rest.php/oauth2/access_token`);
	});

	it('rejects metadata missing S256', async () => {
		fakeAs = await startFakeAs({
			wellKnown: 'origin',
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		await expect(fetchMetadata('k', wikiPointingAt(fakeAs))).rejects.toThrow(MetadataError);
	});

	it('shares one in-flight promise across concurrent callers', async () => {
		fakeAs = await startFakeAs({ wellKnown: 'origin' });
		const [a, b] = await Promise.all([
			fetchMetadata('k', wikiPointingAt(fakeAs)),
			fetchMetadata('k', wikiPointingAt(fakeAs)),
		]);
		expect(a).toBe(b);
	});

	it('falls through to synthesis when metadata is missing authorization_endpoint', async () => {
		fakeAs = await startFakeAs({
			wellKnown: 'origin',
			wellKnownBody: { authorization_endpoint: undefined, token_endpoint: undefined },
		});
		const md = await fetchMetadata('k', wikiPointingAt(fakeAs));
		expect(md.source).toBe('synthesized');
		expect(md.synthesized).toBe(true);
	});

	it('removes the cache entry on rejection so the next caller retries', async () => {
		fakeAs = await startFakeAs({
			wellKnown: 'origin',
			wellKnownBody: { code_challenge_methods_supported: ['plain'] },
		});
		await expect(fetchMetadata('k', wikiPointingAt(fakeAs))).rejects.toThrow(MetadataError);
		// After rejection the cache entry should be cleared.
		// Swap to an absent server so the next call synthesises rather than errors.
		await fakeAs.close();
		fakeAs = await startFakeAs({ wellKnown: 'absent' });
		const md = await fetchMetadata('k', wikiPointingAt(fakeAs));
		expect(md.source).toBe('synthesized');
	});
});
