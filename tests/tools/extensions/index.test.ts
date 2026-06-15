import { describe, it, expect } from 'vitest';
import { extensionPacks } from '../../../src/tools/extensions/index.js';

describe('extensionPacks', () => {
	it('contains smw, bucket, cargo, and neowiki in registration order', () => {
		expect(extensionPacks.map((p) => p.id)).toEqual(['smw', 'bucket', 'cargo', 'neowiki']);
	});

	it('lists NeoWiki as the NeoWiki extension name', () => {
		const neowiki = extensionPacks.find((p) => p.id === 'neowiki');
		expect(neowiki?.extensionNames).toEqual(['NeoWiki']);
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

	it('exposes the eleven NeoWiki tools including the write tools', () => {
		const neowiki = extensionPacks.find((p) => p.id === 'neowiki');
		expect(neowiki?.tools.map((t) => t.name)).toEqual([
			'neowiki-list-schemas',
			'neowiki-get-schema',
			'neowiki-cypher-query',
			'neowiki-search-subjects',
			'neowiki-get-subject',
			'neowiki-get-page-subjects',
			'neowiki-create-subject',
			'neowiki-update-subject',
			'neowiki-delete-subject',
			'neowiki-set-main-subject',
			'neowiki-validate-subject',
		]);
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

	it('every tool declares an explicit boolean readOnlyHint annotation', () => {
		// The read-only gate derives extension write tools from
		// readOnlyHint === false (WRITE_TOOL_NAMES in src/runtime/wikiCapability.ts).
		// readOnlyHint is optional in the SDK type, so a mutating tool that omits it
		// would silently escape the gate. Require every pack tool to state it.
		for (const pack of extensionPacks) {
			for (const tool of pack.tools) {
				expect(
					typeof tool.annotations.readOnlyHint,
					`${tool.name} must declare a boolean readOnlyHint`,
				).toBe('boolean');
			}
		}
	});
});
