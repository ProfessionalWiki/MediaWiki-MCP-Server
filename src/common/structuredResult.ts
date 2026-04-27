/* eslint-disable n/no-missing-import */
import type { CallToolResult, TextContent } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { formatPayload } from './formatPayload.js';

export function structuredResult<T>( data: T ): CallToolResult {
	return {
		content: [
			{ type: 'text', text: formatPayload( data ) } as TextContent
		],
		structuredContent: data as Record<string, unknown>
	};
}
