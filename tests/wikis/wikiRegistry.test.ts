import { describe, it, expect } from 'vitest';
import { WikiRegistryImpl, DuplicateWikiKeyError } from '../../src/wikis/wikiRegistry.js';
import type { WikiConfig } from '../../src/config/loadConfig.js';

const sample = (name: string): WikiConfig => ({
	sitename: name,
	server: `https://${name}`,
	articlepath: '/wiki',
	scriptpath: '/w',
});

describe('WikiRegistryImpl', () => {
	it('getAll returns all configured wikis', () => {
		const reg = new WikiRegistryImpl({ a: sample('a'), b: sample('b') }, true);
		expect(Object.keys(reg.getAll())).toEqual(['a', 'b']);
	});

	it('get returns the wiki config for an existing key', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		expect(reg.get('a')?.sitename).toBe('a');
	});

	it('get returns undefined for an unknown key', () => {
		const reg = new WikiRegistryImpl({}, true);
		expect(reg.get('nope')).toBeUndefined();
	});

	it('add inserts a new wiki', () => {
		const reg = new WikiRegistryImpl({}, true);
		reg.add('a', sample('a'));
		expect(reg.get('a')?.sitename).toBe('a');
	});

	it('add rejects duplicate keys with DuplicateWikiKeyError', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		expect(() => reg.add('a', sample('a'))).toThrow(DuplicateWikiKeyError);
	});

	it('add rejects empty keys', () => {
		const reg = new WikiRegistryImpl({}, true);
		expect(() => reg.add('', sample('x'))).toThrow(/empty/i);
	});

	it('add rejects whitespace-only keys', () => {
		const reg = new WikiRegistryImpl({}, true);
		expect(() => reg.add('   ', sample('x'))).toThrow(/empty/i);
	});

	it('remove drops the key', () => {
		const reg = new WikiRegistryImpl({ a: sample('a') }, true);
		reg.remove('a');
		expect(reg.get('a')).toBeUndefined();
	});

	it('isManagementAllowed reflects the constructor flag', () => {
		expect(new WikiRegistryImpl({}, true).isManagementAllowed()).toBe(true);
		expect(new WikiRegistryImpl({}, false).isManagementAllowed()).toBe(false);
	});

	it('mutates the underlying map in place so external readers see updates', () => {
		const wikis: Record<string, WikiConfig> = { a: sample('a') };
		const reg = new WikiRegistryImpl(wikis, true);
		reg.add('b', sample('b'));
		expect(wikis.b?.sitename).toBe('b');
		reg.remove('a');
		expect(wikis.a).toBeUndefined();
	});
});
