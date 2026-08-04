import type { ExtensionPack } from './types.ts';
import { smwPack } from './smw/index.ts';
import { bucketPack } from './bucket/index.ts';
import { cargoPack } from './cargo/index.ts';
import { neowikiPack } from './neowiki/index.ts';
import { wikibasePack } from './wikibase/index.ts';

export type { ExtensionPack } from './types.ts';

/**
 * A wiki gate names the pack tools it applies to, and reconcile and the per-call
 * guard both work from those names. A name the pack does not provide would gate
 * nothing while reading as though it did, so it fails the server's startup
 * rather than one call.
 */
export function assertWikiGatesNameOwnTools(packs: readonly ExtensionPack[]): void {
	for (const pack of packs) {
		const provided = new Set(pack.tools.map((tool) => tool.name));
		for (const name of pack.wikiGate?.tools ?? []) {
			if (!provided.has(name)) {
				throw new Error(
					`Extension pack "${pack.id}" declares a wikiGate for "${name}", which it does not provide.`,
				);
			}
		}
	}
}

export const extensionPacks: readonly ExtensionPack[] = [
	smwPack,
	bucketPack,
	cargoPack,
	neowikiPack,
	wikibasePack,
];

assertWikiGatesNameOwnTools(extensionPacks);
