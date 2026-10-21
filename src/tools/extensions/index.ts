import type { ExtensionPack } from './types.ts';
import { smwPack } from './smw/index.ts';
import { bucketPack } from './bucket/index.ts';
import { cargoPack } from './cargo/index.ts';
import { neowikiPack } from './neowiki/index.ts';
import { wikibasePack } from './wikibase/index.ts';

export type { ExtensionPack } from './types.ts';
import type { WikiInspection } from '../../wikis/wikiProbe.ts';
import type { ErrorCategory, ExtensionErrorVocabulary } from '../../errors/classifyError.ts';
import { coreErrorCodes } from '../../errors/classifyError.ts';

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

/**
 * The packs' error vocabularies merged into one, for the central classifier.
 *
 * A code two packs both claim, or one the core vocabulary already defines, is a
 * silent reinterpretation of somebody else's error, so it fails the server's
 * startup rather than one call.
 */
export function extensionErrorVocabulary(
	packs: readonly ExtensionPack[],
): ExtensionErrorVocabulary {
	const core = coreErrorCodes();
	const codes: Record<string, ErrorCategory> = {};
	const owner = new Map<string, string>();
	const prefixes: (readonly [RegExp, ErrorCategory])[] = [];

	for (const pack of packs) {
		for (const [code, category] of Object.entries(pack.errorCodes ?? {})) {
			if (Object.hasOwn(core, code)) {
				throw new Error(
					`Extension pack "${pack.id}" declares error code "${code}", which MediaWiki itself defines.`,
				);
			}
			const claimed = owner.get(code);
			if (claimed !== undefined) {
				throw new Error(
					`Extension packs "${claimed}" and "${pack.id}" both declare error code "${code}".`,
				);
			}
			owner.set(code, pack.id);
			codes[code] = category;
		}
		prefixes.push(...(pack.errorCodePrefixes ?? []));
	}

	return { codes, prefixes };
}

/**
 * Why a pack's tool cannot run on a wiki with this identity, or undefined when
 * it can. Reconcile offers the tool while some wiki allows it, the per-call
 * guard refuses a call with the reason, and list-wikis reports it per wiki.
 */
export function packToolRefusal(
	pack: ExtensionPack,
	toolName: string,
	identity: WikiInspection,
	wikiKey: string,
): string | undefined {
	if (!pack.extensionNames.some((name) => identity.extensions.has(name))) {
		const extension = pack.extensionNames[0];
		const reason = identity.reachable
			? `The ${extension} extension is not installed on wiki "${wikiKey}".`
			: `Wiki "${wikiKey}" could not be reached to check for the ${extension} extension.`;
		return `${reason} Use list-wikis to see which wikis support it.`;
	}
	const gate = pack.wikiGate;
	if (gate !== undefined && gate.tools.includes(toolName) && !gate.isSatisfied(identity)) {
		return gate.refusal(wikiKey);
	}
	return undefined;
}

export const extensionPacks: readonly ExtensionPack[] = [
	smwPack,
	bucketPack,
	cargoPack,
	neowikiPack,
	wikibasePack,
];

assertWikiGatesNameOwnTools(extensionPacks);
extensionErrorVocabulary(extensionPacks);
