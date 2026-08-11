import type { Mwn } from 'mwn';
import type { ToolContext } from '../../../runtime/context.ts';
import { resolveSiteInfo } from '../../../wikis/siteInfo.ts';

/** IDs per label request: `wbgetentities` accepts 50 from an ordinary account. */
export const LABEL_CALL_SIZE = 50;

/**
 * A single language code. The term APIs also accept a pipe-separated list, which
 * multiplies the response by the number of codes for terms nothing here renders.
 * Digits belong: `es-419` is Latin American Spanish. MediaWiki codes are
 * lowercase, and `wbgetentities` answers an unrecognised one with every language
 * the entity has rather than an error, so `en-US` is refused here — the one shape
 * of invalid code that no response can be checked against, since a lexeme carries
 * no term maps to check.
 */
export const LANGUAGE_CODE = /^[a-z][a-z0-9-]{1,19}$/;

/**
 * IDs whose labels one rendering resolves, over at most three parallel
 * requests. A single request would spend its whole budget on the property
 * labels of a well-described entity and leave every value a bare ID, which is
 * the readability this rendering exists for. IDs past this cap render bare.
 */
export const MAX_LABEL_IDS = 150;

/** Used when the wiki does not report a content language. */
const FALLBACK_LANGUAGE = 'en';

export interface EntityLabels {
	labels?: Record<string, { value?: string } | undefined>;
}

/**
 * The language term reads are requested in: the caller's choice, else the
 * wiki's own content language (shared cache with page-URL resolution, so this
 * costs no extra request in a normal session).
 */
export async function resolveLanguage(ctx: ToolContext, requested?: string): Promise<string> {
	if (requested !== undefined && requested !== '') {
		return requested;
	}
	const { key } = ctx.activeWiki.get();
	const { lang } = await resolveSiteInfo(ctx, key);
	return lang ?? FALLBACK_LANGUAGE;
}

/** The entity's label in `language`. */
export function labelOf(entity: EntityLabels | undefined, language: string): string | undefined {
	const requested = entity?.labels?.[language]?.value;
	return typeof requested === 'string' ? requested : undefined;
}

/**
 * Whether the wiki knows the code its terms were requested in. `wbgetentities`
 * does not reject an unrecognised `languages` value: it warns and answers with
 * every language the entity has. A recognised code under `languagefallback=1`
 * is always the key its terms come back under, whichever language of the
 * fallback chain supplied them, and a term the chain reaches nowhere is absent
 * rather than substituted. So a map holding languages but not the requested one
 * is the wiki reporting that it never recognised the code.
 */
export function languageRecognised(
	termMaps: readonly (Record<string, unknown> | undefined)[],
	language: string,
): boolean {
	return termMaps.every(
		(terms) =>
			terms === undefined || Object.keys(terms).length === 0 || Object.hasOwn(terms, language),
	);
}

/**
 * Labels for up to MAX_LABEL_IDS entity IDs, requested in parallel. A batch that
 * fails costs only its own labels — parallel requests are exactly what a wiki
 * throttles, and the rest of the rendering is already in hand.
 */
export async function fetchLabels(
	mwn: Mwn,
	ids: readonly string[],
	language: string,
	onBatchFailure?: (err: unknown) => void,
): Promise<Map<string, string>> {
	const wanted = ids.slice(0, MAX_LABEL_IDS);
	const batches: string[][] = [];
	for (let start = 0; start < wanted.length; start += LABEL_CALL_SIZE) {
		batches.push(wanted.slice(start, start + LABEL_CALL_SIZE));
	}

	const settled = await Promise.allSettled(
		batches.map((batch) => requestLabels(mwn, batch, language)),
	);

	const resolved = new Map<string, string>();
	for (const outcome of settled) {
		if (outcome.status === 'rejected') {
			onBatchFailure?.(outcome.reason);
			continue;
		}
		for (const [id, entity] of Object.entries(outcome.value.entities ?? {})) {
			const label = labelOf(entity, language);
			if (label !== undefined) {
				resolved.set(id, label);
			}
		}
	}
	return resolved;
}

async function requestLabels(
	mwn: Mwn,
	ids: readonly string[],
	language: string,
): Promise<{ entities?: Record<string, EntityLabels> }> {
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- wbgetentities response shape; trusted at this boundary
	return (await mwn.request({
		action: 'wbgetentities',
		ids: ids.join('|'),
		props: 'labels',
		languages: language,
		languagefallback: 1,
		format: 'json',
		formatversion: '2',
	})) as { entities?: Record<string, EntityLabels> };
}
