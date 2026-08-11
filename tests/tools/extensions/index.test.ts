import { describe, it, expect } from 'vitest';
import {
	assertWikiGatesNameOwnTools,
	extensionErrorVocabulary,
	extensionPacks,
} from '../../../src/tools/extensions/index.ts';
import type { ErrorCategory } from '../../../src/errors/classifyError.ts';
import type { ExtensionPack } from '../../../src/tools/extensions/types.ts';
import type { Tool } from '../../../src/runtime/tool.ts';

describe('extensionPacks', () => {
	it('contains smw, bucket, cargo, neowiki, and wikibase in registration order', () => {
		expect(extensionPacks.map((p) => p.id)).toEqual([
			'smw',
			'bucket',
			'cargo',
			'neowiki',
			'wikibase',
		]);
	});

	it('lists WikibaseRepository as the Wikibase extension name', () => {
		const wikibase = extensionPacks.find((p) => p.id === 'wikibase');
		expect(wikibase?.extensionNames).toEqual(['WikibaseRepository']);
	});

	it('exposes the five Wikibase tools including the write tools', () => {
		const wikibase = extensionPacks.find((p) => p.id === 'wikibase');
		expect(wikibase?.tools.map((t) => t.name)).toEqual([
			'wikibase-search-entities',
			'wikibase-get-entity',
			'wikibase-query',
			'wikibase-edit-entity',
			'wikibase-add-statement',
		]);
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

	it('every wiki gate names only tools its own pack provides', () => {
		expect(() => assertWikiGatesNameOwnTools(extensionPacks)).not.toThrow();
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

describe('assertWikiGatesNameOwnTools', () => {
	// Only `name` is read: a gate is matched against the pack's tool names.
	// oxlint-disable-next-line typescript/no-explicit-any
	const tool = (name: string): Tool<any> => ({ name }) as unknown as Tool<any>;

	function gatedPack(gatedToolNames: readonly string[]): ExtensionPack {
		return {
			id: 'demo',
			extensionNames: ['Demo'],
			tools: [tool('demo-read'), tool('demo-query')],
			wikiGate: {
				tools: gatedToolNames,
				isSatisfied: () => true,
				refusal: (wikiKey) => `Wiki "${wikiKey}" is not set up for this.`,
			},
		};
	}

	it('rejects a gate naming a tool the pack does not provide', () => {
		expect(() => assertWikiGatesNameOwnTools([gatedPack(['demo-query', 'demo-typo'])])).toThrow(
			/demo-typo/,
		);
	});

	it('accepts a gate over the pack’s own tools', () => {
		expect(() => assertWikiGatesNameOwnTools([gatedPack(['demo-query'])])).not.toThrow();
	});

	function codePack(id: string, codes: Record<string, ErrorCategory>): ExtensionPack {
		return { id, extensionNames: ['Demo'], tools: [tool(`${id}-read`)], errorCodes: codes };
	}

	it('merges the codes each pack declares', () => {
		const merged = extensionErrorVocabulary([
			codePack('one', { 'one-broke': 'invalid_input' }),
			codePack('two', { 'two-broke': 'not_found' }),
		]);

		expect(merged.codes).toEqual({ 'one-broke': 'invalid_input', 'two-broke': 'not_found' });
	});

	// Either overlap would let one pack silently change how another pack's, or the
	// wiki's own, failure reads.
	it('rejects a code two packs both claim', () => {
		expect(() =>
			extensionErrorVocabulary([
				codePack('one', { 'both-broke': 'invalid_input' }),
				codePack('two', { 'both-broke': 'not_found' }),
			]),
		).toThrow(/both-broke/);
	});

	it('rejects a code MediaWiki itself defines', () => {
		expect(() =>
			extensionErrorVocabulary([codePack('one', { badtoken: 'invalid_input' })]),
		).toThrow(/badtoken/);
	});

	it('accepts the packs the server actually ships', () => {
		expect(() => extensionErrorVocabulary(extensionPacks)).not.toThrow();
	});
});
