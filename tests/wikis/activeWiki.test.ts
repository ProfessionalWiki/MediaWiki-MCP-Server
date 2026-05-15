import { describe, it, expect } from 'vitest';
import { ActiveWikiImpl } from '../../src/wikis/activeWiki.js';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.js';
import { withRequestFields } from '../../src/transport/requestContext.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

describe('ActiveWikiImpl', () => {
	it('get returns the default wiki when no request wiki is set', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const activeWiki = new ActiveWikiImpl('a', reg);
		expect(activeWiki.get().key).toBe('a');
		expect(activeWiki.get().config.sitename).toBe('a');
	});

	it('get follows the request-context wiki when one is set', async () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const activeWiki = new ActiveWikiImpl('a', reg);
		await withRequestFields({ wikiKey: 'b' }, async () => {
			expect(activeWiki.get().key).toBe('b');
			expect(activeWiki.get().config.sitename).toBe('b');
		});
	});

	it('getDefaultKey returns the configured default', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const activeWiki = new ActiveWikiImpl('a', reg);
		expect(activeWiki.getDefaultKey()).toBe('a');
	});

	it('get throws when the resolved wiki is not in the registry', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const activeWiki = new ActiveWikiImpl('a', reg);
		reg.remove('a');
		expect(() => activeWiki.get()).toThrow(/not found/);
	});
});
