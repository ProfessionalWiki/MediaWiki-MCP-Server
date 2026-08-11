import type { Tool } from '../../runtime/tool.ts';
import type { WikiIdentity } from '../../wikis/wikiProbe.ts';
import type { ErrorCategory } from '../../errors/classifyError.ts';

/**
 * A condition some of a pack's tools need beyond the extension itself, for a
 * capability the extension list alone does not reveal. It is answered from the
 * wiki's probed identity, the same siteinfo snapshot the extension gate reads.
 *
 * The gate is enforced centrally, by the per-call capability guard, so a pack
 * that declares one cannot forget to check it in a handler. It supplies the
 * refusal text because only the pack knows what the wiki is missing.
 */
export interface WikiGate {
	/**
	 * The pack tools the condition applies to; its other tools are unaffected.
	 * Every name must be one the pack provides, which is checked at registration.
	 */
	readonly tools: readonly string[];
	readonly isSatisfied: (identity: WikiIdentity) => boolean;
	/** What a call to a wiki that does not satisfy the gate is refused with. */
	readonly refusal: (wikiKey: string) => string;
}

export interface ExtensionPack {
	/** Stable id used for rule names and telemetry; e.g. 'cargo'. Conventionally
	 *  matches the tool-name prefix shared by tools in the pack. */
	readonly id: string;

	/** MediaWiki extension names accepted as proof the pack applies to the
	 *  active wiki. Multiple entries handle aliases (Cargo / LIBRARIAN). The
	 *  pack is allowed iff `wikiProbe.hasAnyExtension(activeWikiKey, extensionNames)`. */
	readonly extensionNames: readonly string[];

	/** Tools provided by this pack. The unifying property is the gate, not the
	 *  request mechanism — pack tools may use action API, rawRequest, or REST. */
	// `Tool<any>[]` widens the heterogeneous-schema array; see `standardTools`
	// in `src/tools/index.ts` for the variance rationale.
	// oxlint-disable-next-line typescript/no-explicit-any
	readonly tools: readonly Tool<any>[];

	/** Extra gate on some of the tools above, conjoined with the extension gate
	 *  per wiki: the tools are offered while some ONE configured wiki both has
	 *  the extension and satisfies the gate, and the pack refuses a call to any
	 *  wiki that does not. */
	readonly wikiGate?: WikiGate;

	/**
	 * Error codes this pack's extension adds to the action API's vocabulary,
	 * mapped to the category a caller should read them as.
	 *
	 * A pack whose tools reach the wiki through mwn never sees its own errors:
	 * mwn throws, and the dispatcher classifies centrally. Declaring the codes
	 * here keeps that one dispatch point while leaving the vocabulary with the
	 * pack that knows it, so removing a pack removes its codes. A pack with its
	 * own transport classifies its own failures instead and needs none of this.
	 *
	 * Codes are checked against the core vocabulary and each other at startup, so
	 * a pack cannot quietly reinterpret a code another one already owns.
	 */
	readonly errorCodes?: Readonly<Record<string, ErrorCategory>>;

	/**
	 * The same, for code families the extension numbers per case and so cannot
	 * list exactly — Wikibase answers an unreadable JSON value with
	 * `not-recognized-<shape>`, one code per shape it expected.
	 */
	readonly errorCodePrefixes?: readonly (readonly [RegExp, ErrorCategory])[];
}
