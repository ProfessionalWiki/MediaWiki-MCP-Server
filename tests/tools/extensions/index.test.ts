import { describe, it, expect } from 'vitest';
import { extensionPacks } from '../../../src/tools/extensions/index.js';

describe('extensionPacks', () => {
	it('contains smw, bucket, and cargo in registration order', () => {
		expect(extensionPacks.map((p) => p.id)).toEqual(['smw', 'bucket', 'cargo']);
	});

	it('lists Cargo and LIBRARIAN as Cargo extension names', () => {
		const cargo = extensionPacks.find((p) => p.id === 'cargo');
		expect(cargo?.extensionNames).toEqual(['Cargo', 'LIBRARIAN']);
	});

	it('lists SemanticMediaWiki as the SMW extension name', () => {
		const smw = extensionPacks.find((p) => p.id === 'smw');
		expect(smw?.extensionNames).toEqual(['SemanticMediaWiki']);
	});

	it('lists Bucket as the Bucket extension name', () => {
		const bucket = extensionPacks.find((p) => p.id === 'bucket');
		expect(bucket?.extensionNames).toEqual(['Bucket']);
	});

	it('all tool names across packs are unique', () => {
		const allNames = extensionPacks.flatMap((p) => p.tools.map((t) => t.name));
		expect(new Set(allNames).size).toBe(allNames.length);
	});

	it('every tool name starts with its pack id followed by a dash', () => {
		for (const pack of extensionPacks) {
			for (const tool of pack.tools) {
				expect(tool.name.startsWith(`${pack.id}-`)).toBe(true);
			}
		}
	});
});
