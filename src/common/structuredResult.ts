/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */

export function structuredResult<T>( data: T ): CallToolResult {
	return {
		structuredContent: data as Record<string, unknown>,
		content: [
			{ type: 'text', text: JSON.stringify( data ) } as TextContent
		]
	};
}
