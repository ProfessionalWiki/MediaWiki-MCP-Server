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
