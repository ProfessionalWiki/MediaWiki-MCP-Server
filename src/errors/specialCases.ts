import type { ErrorCategory } from './classifyError.js';
import { errorMessage } from './isErrnoException.js';

export interface SpecialCaseResult {
	category: ErrorCategory;
	code: string;
	message: string;
}

type Override = (
	err: unknown,
	context: { toolName: string; defaultMessage: string },
) => SpecialCaseResult | null;

function pickFromMessage(msg: string, pattern: RegExp): string | undefined {
	return msg.match(pattern)?.[1];
}

// Tools whose pre-refactor error wording included tailored, code-specific
// messages (rather than the generic "Failed to <verb>: <raw>" prefix). Only
// these tools opt into the matching override below — every other tool keeps
// the raw upstream message and the dispatcher's standard verb prefix.
const TAILORED_TOOLS: Record<string, ReadonlySet<string>> = {
	missingtitle: new Set(['compare-pages']),
	nosuchrevid: new Set(['compare-pages']),
	nosuchsection: new Set(['update-page']),
	internal_api_error_MWException: new Set(['cargo-describe-table']),
};

function appliesTo(code: string, toolName: string): boolean {
	return TAILORED_TOOLS[code]?.has(toolName) ?? false;
}

const overrides: Record<string, Override> = {
	nosuchsection: (err, { toolName }) => {
		if (!appliesTo('nosuchsection', toolName)) {
			return null;
		}
		const msg = errorMessage(err, '');
		const sectionMatch = pickFromMessage(msg, /section[^\d]*(\d+)/i);
		const label = sectionMatch ?? 'unknown';
		return {
			category: 'not_found',
			code: 'nosuchsection',
			message: `Section ${label} does not exist`,
		};
	},
	nosuchrevid: (err, { toolName }) => {
		if (!appliesTo('nosuchrevid', toolName)) {
			return null;
		}
		const msg = errorMessage(err, '');
		const idMatch = pickFromMessage(msg, /\b(\d+)\b/);
		return {
			category: 'not_found',
			code: 'nosuchrevid',
			message: idMatch !== undefined ? `Revision ${idMatch} not found` : 'Revision not found',
		};
	},
	missingtitle: (err, { toolName }) => {
		if (!appliesTo('missingtitle', toolName)) {
			return null;
		}
		const msg = errorMessage(err, '');
		const titleMatch = pickFromMessage(msg, /["'`]([^"'`]+)["'`]/);
		return {
			category: 'not_found',
			code: 'missingtitle',
			message: titleMatch !== undefined ? `Page "${titleMatch}" not found` : 'Page not found',
		};
	},
	internal_api_error_MWException: (_err, { toolName }) => {
		if (!appliesTo('internal_api_error_MWException', toolName)) {
			return null;
		}
		if (toolName === 'cargo-describe-table') {
			return {
				category: 'invalid_input',
				code: 'internal_api_error_MWException',
				message: 'Table not found. Use cargo-list-tables to see available table names.',
			};
		}
		return null;
	},
};

export function applySpecialCase(
	toolName: string,
	classified: { category: ErrorCategory; code?: string },
	err: unknown,
): { category: ErrorCategory; code: string | undefined; message: string } {
	const defaultMessage = errorMessage(err);
	if (classified.code && overrides[classified.code]) {
		const result = overrides[classified.code](err, { toolName, defaultMessage });
		if (result) {
			return result;
		}
	}
	return { category: classified.category, code: classified.code, message: defaultMessage };
}
