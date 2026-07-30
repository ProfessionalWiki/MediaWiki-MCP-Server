import type { ExtensionPack } from '../types.ts';
import { cargoListTables } from './cargo-list-tables.ts';
import { cargoDescribeTable } from './cargo-describe-table.ts';
import { cargoQuery } from './cargo-query.ts';

// wiki.gg-hosted wikis (Helldivers, Terraria, Ark, etc.) ship Cargo under the
// rebranded name `LIBRARIAN`. Same author (Yaron Koren), same upstream, same
// API. Accept either name when probing the active wiki's extensions.
const CARGO_EXTENSION_NAMES: readonly string[] = ['Cargo', 'LIBRARIAN'];

export const cargoPack: ExtensionPack = {
	id: 'cargo',
	extensionNames: CARGO_EXTENSION_NAMES,
	tools: [cargoListTables, cargoDescribeTable, cargoQuery],
};
