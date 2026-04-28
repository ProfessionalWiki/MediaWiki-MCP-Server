import type { ErrorCategory } from './classifyError.js';

export interface SpecialCaseResult {
	category: ErrorCategory;
	code: string;
	message: string;
}

type Override = (
	err: unknown,
	context: { toolName: string; defaultMessage: string }
) => SpecialCaseResult | null;

function pickFromMessage( msg: string, pattern: RegExp ): string | undefined {
	return msg.match( pattern )?.[ 1 ];
}

// Tools whose pre-refactor error wording included tailored, code-specific
// messages (rather than the generic "Failed to <verb>: <raw>" prefix). Only
// these tools opt into the matching override below — every other tool keeps
// the raw upstream message and the dispatcher's standard verb prefix.
const TAILORED_TOOLS: Record<string, ReadonlySet<string>> = {
	missingtitle: new Set( [ 'get-page', 'get-page-history', 'get-file', 'compare-pages' ] ),
	nosuchrevid: new Set( [ 'get-revision', 'compare-pages' ] ),
	nosuchsection: new Set( [ 'get-page', 'update-page' ] )
};

function appliesTo( code: string, toolName: string ): boolean {
	return TAILORED_TOOLS[ code ]?.has( toolName ) ?? false;
}

const overrides: Record<string, Override> = {
	nosuchsection: ( err, { toolName } ) => {
		if ( !appliesTo( 'nosuchsection', toolName ) ) {
			return null;
		}
		const msg = ( err as Error ).message ?? '';
		const sectionMatch = pickFromMessage( msg, /section[^\d]*(\d+)/i );
		const label = sectionMatch ?? 'unknown';
		return { category: 'not_found', code: 'nosuchsection', message: `Section ${ label } does not exist` };
	},
	nosuchrevid: ( err, { toolName } ) => {
		if ( !appliesTo( 'nosuchrevid', toolName ) ) {
			return null;
		}
		const msg = ( err as Error ).message ?? '';
		const idMatch = pickFromMessage( msg, /\b(\d+)\b/ );
		return {
			category: 'not_found',
			code: 'nosuchrevid',
			message: idMatch !== undefined ? `Revision ${ idMatch } not found` : 'Revision not found'
		};
	},
	missingtitle: ( err, { toolName } ) => {
		if ( !appliesTo( 'missingtitle', toolName ) ) {
			return null;
		}
		const msg = ( err as Error ).message ?? '';
		const titleMatch = pickFromMessage( msg, /["'`]([^"'`]+)["'`]/ );
		return {
			category: 'not_found',
			code: 'missingtitle',
			message: titleMatch !== undefined ? `Page "${ titleMatch }" not found` : 'Page not found'
		};
	}
};

export function applySpecialCase(
	toolName: string,
	classified: { category: ErrorCategory; code?: string },
	err: unknown
): { category: ErrorCategory; code: string | undefined; message: string } {
	const defaultMessage = ( err as Error ).message ?? 'Unknown error';
	if ( classified.code && overrides[ classified.code ] ) {
		const result = overrides[ classified.code ]( err, { toolName, defaultMessage } );
		if ( result ) {
			return result;
		}
	}
	return { category: classified.category, code: classified.code, message: defaultMessage };
}
