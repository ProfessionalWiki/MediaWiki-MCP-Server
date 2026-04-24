/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { STRUCTURED_OUTPUT_ENABLED } from './featureFlags.js';

export function structuredResult<T>( data: T ): CallToolResult {
	if ( STRUCTURED_OUTPUT_ENABLED ) {
		return {
			structuredContent: data as Record<string, unknown>,
			content: []
		};
	}
	return {
		content: [
			{ type: 'text', text: JSON.stringify( data ) } as TextContent
		]
	};
}
