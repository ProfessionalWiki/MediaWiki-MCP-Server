/* eslint-disable n/no-missing-import */
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import type { ErrorCategory } from '../errors/classifyError.js';
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
