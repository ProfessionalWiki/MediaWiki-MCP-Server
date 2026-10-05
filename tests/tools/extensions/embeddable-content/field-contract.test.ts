import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, it, expect } from 'vitest';
import {
	SEMANTIC_ENTITY_FIELD_NAMES,
	SOURCE_FIELD_NAMES,
	SPECIAL_CONTENT_FIELD_NAMES,
} from '../../../../src/tools/extensions/embeddable-content/generated/fieldContract.ts';
import { embeddableAddCitationSource } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-citation-source.ts';
import { embeddableAddSemanticEntity } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-semantic-entity.ts';
import { embeddableAddSpecialContent } from '../../../../src/tools/extensions/embeddable-content/embeddable-add-special-content.ts';

// The drift guard's runtime half: the generated field tuples and each tool's
// schema must agree with the pinned canonical contract. The compile-time half
// (`satisfies Record<FieldName, ZodTypeAny>`) and CI's `gen:field-contract` +
// `git diff --exit-code` run together; this test fails locally on a stale
// generated file or a hand-edited contract even before CI.
//
// Keep EXCLUDED in step with scripts/gen-embeddable-contract.cjs.
const EXCLUDED: Record<string, string[]> = {
	'special-content': [],
	'citation-source': [],
	'semantic-entity': ['pageKind'],
};

const contractPath = join(
	dirname(fileURLToPath(import.meta.url)),
	'../../../../src/tools/extensions/embeddable-content/contract/field-contract.json',
);
// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- JSON test fixture
const contract = JSON.parse(readFileSync(contractPath, 'utf8')) as {
	flows: Record<
		string,
		{ kinds?: Record<string, { fields: string[] }>; classes?: Record<string, { fields: string[] }> }
	>;
};

function contractUnion(flow: string): string[] {
	const node = contract.flows[flow];
	const group = node.kinds ?? node.classes ?? {};
	const excluded = new Set(EXCLUDED[flow] ?? []);
	const seen = new Set<string>();
	for (const entry of Object.values(group)) {
		for (const field of entry.fields) {
			if (!excluded.has(field)) {
				seen.add(field);
			}
		}
	}
	return [...seen];
}

function schemaFieldKeys(schema: Record<string, unknown>, toolLevel: string[]): string[] {
	return Object.keys(schema).filter((key) => !toolLevel.includes(key));
}

const TOOL_LEVEL = ['kind', 'classKey', 'qid', 'confirmDuplicate', 'comment'];

describe('embeddable field contract', () => {
	it('generates the special-content tuple from the contract', () => {
		expect([...SPECIAL_CONTENT_FIELD_NAMES]).toEqual(contractUnion('special-content'));
	});

	it('generates the citation-source tuple from the contract', () => {
		expect([...SOURCE_FIELD_NAMES]).toEqual(contractUnion('citation-source'));
	});

	it('generates the semantic-entity tuple from the contract', () => {
		expect([...SEMANTIC_ENTITY_FIELD_NAMES]).toEqual(contractUnion('semantic-entity'));
	});

	it('exposes exactly the generated fields on each add tool (bar tool-level params)', () => {
		// Order-insensitive: the validator table is authored for readability,
		// the contract tuple carries the canonical order.
		const sorted = (values: readonly string[]) => [...values].sort();
		expect(sorted(schemaFieldKeys(embeddableAddSpecialContent.inputSchema, TOOL_LEVEL))).toEqual(
			sorted(SPECIAL_CONTENT_FIELD_NAMES),
		);
		expect(sorted(schemaFieldKeys(embeddableAddCitationSource.inputSchema, TOOL_LEVEL))).toEqual(
			sorted(SOURCE_FIELD_NAMES),
		);
		expect(sorted(schemaFieldKeys(embeddableAddSemanticEntity.inputSchema, TOOL_LEVEL))).toEqual(
			sorted(SEMANTIC_ENTITY_FIELD_NAMES),
		);
	});
});
