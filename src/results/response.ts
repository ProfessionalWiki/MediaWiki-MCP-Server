/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { ErrorEnvelope } from '../common/schemas.js';
import type { ErrorCategory } from '../errors/classifyError.js';
import { formatPayload } from './format.js';
import type { TruncationInfo } from './truncation.js';

export interface ResponseFormatter {
	ok( payload: unknown ): CallToolResult;
	error( category: ErrorCategory, message: string, code?: string ): CallToolResult;
	notFound( message: string, code?: string ): CallToolResult;
	invalidInput( message: string ): CallToolResult;
	conflict( message: string, code?: string ): CallToolResult;
	permissionDenied( message: string, code?: string ): CallToolResult;
	truncationMarker( info: TruncationInfo ): string;
}

export function structuredResult<T>( data: T ): CallToolResult {
	return {
		content: [
			{ type: 'text', text: formatPayload( data ) } as TextContent
		]
	};
}

export function errorResult(
	category: ErrorCategory,
	message: string,
	code?: string
): CallToolResult {
	// Error envelopes ride as JSON in content[0].text — same channel as the
	// success-path prose — paired with isError: true. Clients distinguish
	// success from error by the isError flag and parse the envelope from the
	// text block when they want the typed shape.
	const envelope: ErrorEnvelope = code !== undefined ?
		{ category, message, code } :
		{ category, message };
	return {
		content: [ { type: 'text', text: JSON.stringify( envelope ) } as TextContent ],
		isError: true
	};
}

export class ResponseFormatterImpl implements ResponseFormatter {
	public ok( payload: unknown ): CallToolResult {
		return structuredResult( payload );
	}

	public error( category: ErrorCategory, message: string, code?: string ): CallToolResult {
		return errorResult( category, message, code );
	}

	public notFound( message: string, code?: string ): CallToolResult {
		return this.error( 'not_found', message, code );
	}

	public invalidInput( message: string ): CallToolResult {
		return this.error( 'invalid_input', message );
	}

	public conflict( message: string, code?: string ): CallToolResult {
		return this.error( 'conflict', message, code );
	}

	public permissionDenied( message: string, code?: string ): CallToolResult {
		return this.error( 'permission_denied', message, code );
	}

	public truncationMarker( info: TruncationInfo ): string {
		switch ( info.reason ) {
			case 'content-truncated': {
				const sections = info.sections && info.sections.length > 0 ?
					` Available sections: ${ info.sections.map( ( s, i ) => `${ i } (${ s || 'Lead' })` ).join( ', ' ) }.` :
					'';
				return `Content (${ info.itemNoun }) truncated at ${ info.returnedBytes } of ${ info.totalBytes } bytes.${ sections } ${ info.remedyHint }`;
			}
			case 'more-available':
				return `More results available. Returned ${ info.returnedCount } ${ info.itemNoun }. To fetch the next segment, call ${ info.toolName } again with ${ info.continueWith.param }=${ info.continueWith.value }.`;
			case 'capped-no-continuation':
				return `Result capped at ${ info.limit } ${ info.itemNoun }. Additional ${ info.itemNoun } may exist — ${ info.narrowHint }`;
		}
	}
}
