import type { Tool } from '../../runtime/tool.js';

export interface ExtensionPack {
	/** Stable id used for rule names and telemetry; e.g. 'cargo'. Conventionally
	 *  matches the tool-name prefix shared by tools in the pack. */
	readonly id: string;

	/** MediaWiki extension names accepted as proof the pack applies to the
	 *  active wiki. Multiple entries handle aliases (Cargo / LIBRARIAN). The
	 *  pack is allowed iff `extensions.hasAny(activeWikiKey, extensionNames)`. */
	readonly extensionNames: readonly string[];

	/** Tools provided by this pack. The unifying property is the gate, not the
	 *  request mechanism — pack tools may use action API, rawRequest, or REST. */
	// oxlint-disable-next-line typescript/no-explicit-any
	readonly tools: readonly Tool<any>[];
}
