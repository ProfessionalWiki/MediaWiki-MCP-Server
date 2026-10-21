import type { ErrorCategory } from './classifyError.ts';

/** How a tool words one of the wiki's errors, in place of "Failed to <verb>: …". */
export interface TailoredError {
	readonly category: ErrorCategory;
	readonly message: string;
}

/**
 * A tool's wordings, by the wiki's error code; each receives the wiki's message,
 * and returns undefined to leave an error it does not recognise to the default.
 */
export type TailoredErrors = Readonly<
	Record<string, (message: string) => TailoredError | undefined>
>;

function pickFromMessage(message: string, pattern: RegExp): string | undefined {
	return message.match(pattern)?.[1];
}

export function sectionNotFound(message: string): TailoredError {
	const section = pickFromMessage(message, /section[^\d]*(\d+)/i) ?? 'unknown';
	return { category: 'not_found', message: `Section ${section} does not exist` };
}

export function revisionNotFound(message: string): TailoredError {
	const id = pickFromMessage(message, /\b(\d+)\b/);
	return {
		category: 'not_found',
		message: id !== undefined ? `Revision ${id} not found` : 'Revision not found',
	};
}

export function pageNotFound(message: string): TailoredError {
	// MediaWiki's English wording names the page unquoted; other wordings may quote it.
	const title =
		pickFromMessage(message, /The page (.+?) doesn['’]t exist/) ??
		pickFromMessage(message, /["'`]([^"'`]+)["'`]/);
	return {
		category: 'not_found',
		message: title !== undefined ? `Page "${title}" not found` : 'Page not found',
	};
}

/** The tool's wording for `code`, if it declares one; built-in object members never match. */
export function tailoredError(
	wordings: TailoredErrors | undefined,
	code: string | undefined,
	message: string,
): TailoredError | undefined {
	if (wordings === undefined || code === undefined || !Object.hasOwn(wordings, code)) {
		return undefined;
	}
	return wordings[code](message);
}
