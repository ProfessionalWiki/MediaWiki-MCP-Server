import type { ExtensionPack } from '../types.ts';
import { cargoListTables } from './cargo-list-tables.ts';
import { cargoDescribeTable } from './cargo-describe-table.ts';
import { cargoQuery } from './cargo-query.ts';

// wiki.gg wikis run `LIBRARIAN`, wiki.gg's fork of Cargo, so either name counts
// as the extension.
const CARGO_EXTENSION_NAMES: readonly string[] = ['Cargo', 'LIBRARIAN'];

export const cargoPack: ExtensionPack = {
	id: 'cargo',
	extensionNames: CARGO_EXTENSION_NAMES,
	tools: [cargoListTables, cargoDescribeTable, cargoQuery],
};
