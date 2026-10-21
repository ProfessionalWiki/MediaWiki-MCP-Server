import { describe, it, expect } from 'vitest';
import { resolveSiteInfo } from '../../src/wikis/siteInfo.ts';
import { fakeContext, probeReporting } from '../helpers/fakeContext.ts';

describe('resolveSiteInfo', () => {
	// A root article path is the empty string, which must not read as missing.
	it('takes the server and article path the probe read from the wiki', async () => {
		const ctx = fakeContext({
			wikiProbe: probeReporting({ server: 'https://public.example', articlepath: '' }),
		});

		expect(await resolveSiteInfo(ctx, 'test-wiki')).toMatchObject({
			server: 'https://public.example',
			articlepath: '',
		});
	});

	it('uses the configured server and article path while the probe has read none', async () => {
		const ctx = fakeContext({ wikiProbe: probeReporting({}) });

		expect(await resolveSiteInfo(ctx, 'test-wiki')).toMatchObject({
			server: 'https://test.wiki',
			articlepath: '/wiki',
		});
	});
});
