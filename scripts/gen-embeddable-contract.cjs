#!/usr/bin/env node
// Generates the EmbeddableContent add tools' field tables from the pinned
// canonical contract (src/tools/extensions/embeddable-content/contract/
// field-contract.json), emitted by the wiki's EmbeddableContent extension
// (maintenance/emitFieldContract.php).
//
// The generated file is the tool input surface: each tool enforces coverage
// with `satisfies Record<FieldName, z.ZodTypeAny>`, so a field added to the
// wiki contract (and re-emitted) fails COMPILATION until the tool exposes it
// or the EXCLUDED map below documents why it must not. `npm run
// gen:field-contract` writes the file; CI re-runs it and fails on any diff
// (the preflight "Ensure no changes" step), so a stale generated file or a
// contract edit without regeneration cannot land.
//
// Refresh the pinned contract from the wiki repo:
//   cp <ronzz-wikibase>/extensions/EmbeddableContent/contract/field-contract.json \
//      src/tools/extensions/embeddable-content/contract/field-contract.json
// then run this script.

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const root = path.resolve(__dirname, '..');
const contractPath = path.join(
	root,
	'src/tools/extensions/embeddable-content/contract/field-contract.json',
);
const outPath = path.join(
	root,
	'src/tools/extensions/embeddable-content/generated/fieldContract.ts',
);

// Contract fields the MCP tools deliberately do NOT expose, per flow, each
// with the reason. A field named here that is not in the contract fails the
// generator (a stale exclusion must not silently hide a field).
const EXCLUDED = {
	'special-content': {},
	'citation-source': {},
	'semantic-entity': {
		pageKind:
			"the classic-page kind derives from the license (the flow's default); not a machine-client field",
	},
};

const contract = JSON.parse(fs.readFileSync(contractPath, 'utf8'));

/** The per-key map (kinds or classes) of a flow. */
function group(flow) {
	const node = contract.flows[flow];
	if (!node) {
		throw new Error(`contract has no flow "${flow}"`);
	}
	const map = node.kinds ?? node.classes;
	if (!map) {
		throw new Error(`flow "${flow}" carries neither kinds nor classes`);
	}
	return map;
}

/** The MCP-exposed union of a flow's fields, in first-encounter order. */
function fieldNames(flow) {
	const excluded = EXCLUDED[flow] ?? {};
	const exposed = new Set();
	const all = new Set();
	for (const entry of Object.values(group(flow))) {
		for (const field of entry.fields) {
			all.add(field);
			if (!(field in excluded)) {
				exposed.add(field);
			}
		}
	}
	for (const field of Object.keys(excluded)) {
		if (!all.has(field)) {
			throw new Error(
				`EXCLUDED['${flow}'] names "${field}", which is not a field of the ${flow} contract — remove the stale exclusion`,
			);
		}
	}
	return [...exposed];
}

const tsArray = (values) => `[${values.map((v) => `'${v}'`).join(', ')}]`;
const pascal = (prefix) =>
	prefix
		.toLowerCase()
		.split('_')
		.map((part) => part[0].toUpperCase() + part.slice(1))
		.join('');

/**
 * Emits the const tuple + its type for one flow.
 */
function fieldTable(prefix, flow) {
	const names = fieldNames(flow);
	const constNameValue = `${prefix}_FIELD_NAMES`;
	const typeName = `${pascal(prefix)}Field`;
	return [
		`export const ${constNameValue} = ${tsArray(names)} as const;`,
		`export type ${typeName} = (typeof ${constNameValue})[number];`,
	].join('\n');
}

const special = fieldTable('SPECIAL_CONTENT', 'special-content');
const source = fieldTable('SOURCE', 'citation-source');
const semantic = fieldTable('SEMANTIC_ENTITY', 'semantic-entity');

const output = `// AUTO-GENERATED — do not edit by hand.
//
// Source: contract/field-contract.json, emitted by the ronzz-wikibase
// EmbeddableContent extension (maintenance/emitFieldContract.php). The wiki's
// Flow/*FieldMap classes are the single authoring source; this file is a
// projection of the contract they publish.
//
// Regenerate: npm run gen:field-contract
//
// Each add tool declares its field validators as
// \`satisfies Record<<Field>, z.ZodTypeAny>\`, so adding, renaming or removing a
// contract field fails compilation until the tool and the generator's
// EXCLUDED map are brought in step — the drift guard.

export const SPECIAL_CONTENT_KINDS = ${tsArray(Object.keys(group('special-content')))} as const;
export type SpecialContentKind = (typeof SPECIAL_CONTENT_KINDS)[number];

${special}

export const SOURCE_CLASS_KEYS = ${tsArray(Object.keys(group('citation-source')))} as const;
export type SourceClassKey = (typeof SOURCE_CLASS_KEYS)[number];

${source}

export const SEMANTIC_ENTITY_KINDS = ${tsArray(Object.keys(group('semantic-entity')))} as const;
export type SemanticEntityKind = (typeof SEMANTIC_ENTITY_KINDS)[number];

${semantic}
`;

fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, output);

// Keep the committed generated file in oxfmt's canonical form so
// `fmt:check` and the drift diff stay meaningful.
execFileSync(path.join(root, 'node_modules/.bin/oxfmt'), [outPath], { stdio: 'inherit' });

process.stdout.write(`wrote ${path.relative(root, outPath)}\n`);
