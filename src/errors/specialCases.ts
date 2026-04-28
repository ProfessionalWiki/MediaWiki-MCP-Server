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

const overrides: Record<string, Override> = {
	nosuchsection: ( err ) => {
		const msg = ( err as Error ).message ?? '';
		const sectionMatch = pickFromMessage( msg, /section[^\d]*(\d+)/i );
		const label = sectionMatch ?? 'unknown';
		return { category: 'not_found', code: 'nosuchsection', message: `Section ${ label } does not exist` };
	},
	nosuchrevid: ( err ) => {
		const msg = ( err as Error ).message ?? '';
		const idMatch = pickFromMessage( msg, /\b(\d+)\b/ );
		return {
			category: 'not_found',
			code: 'nosuchrevid',
			message: idMatch !== undefined ? `Revision ${ idMatch } not found` : 'Revision not found'
		};
	},
	missingtitle: ( err ) => {
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
