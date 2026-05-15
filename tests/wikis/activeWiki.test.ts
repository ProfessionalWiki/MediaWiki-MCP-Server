import { describe, it, expect } from 'vitest';
import { ActiveWikiImpl } from '../../src/wikis/activeWiki.js';
import { WikiRegistryImpl } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

describe('ActiveWikiImpl', () => {
	it('get returns the default wiki initially', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		expect(sel.get().key).toBe('a');
		expect(sel.get().config.sitename).toBe('a');
	});

	it('get throws when the current wiki was removed from the registry', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		reg.remove('a');
		expect(() => sel.get()).toThrow(/not found/);
	});

	it('setCurrent switches to a known wiki', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		sel.setCurrent('b');
		expect(sel.get().key).toBe('b');
	});

	it('setCurrent throws for unknown wiki', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		expect(() => sel.setCurrent('unknown')).toThrow(/not found/);
	});

	it('reset returns to the default', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		const sel = new ActiveWikiImpl('a', reg);
		sel.setCurrent('b');
		sel.reset();
		expect(sel.get().key).toBe('a');
	});

	it('reset throws when default is missing', () => {
		const reg = new WikiRegistryImpl({}, true);
		const sel = new ActiveWikiImpl('gone', reg);
		expect(() => sel.reset()).toThrow(/not found/);
	});
});
