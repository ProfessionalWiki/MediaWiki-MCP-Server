/* eslint-disable n/no-missing-import */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import type { WikiConfig } from '../common/config.js';

const WRITE_TOOL_NAMES: readonly string[] = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url'
];

export function reconcileToolsForActiveWiki(
	tools: Map<string, RegisteredTool>,
	activeWiki: Readonly<WikiConfig>
): void {
	applyReadOnlyRule( tools, activeWiki );
	// Future rules (e.g. extension-gating) are added here.
}

function applyReadOnlyRule(
	tools: Map<string, RegisteredTool>,
	activeWiki: Readonly<WikiConfig>
): void {
	const shouldBeEnabled = !activeWiki.readOnly;
	for ( const name of WRITE_TOOL_NAMES ) {
		const tool = tools.get( name );
		if ( !tool ) {
			continue;
		}
		if ( shouldBeEnabled && !tool.enabled ) {
			tool.enable();
		} else if ( !shouldBeEnabled && tool.enabled ) {
			tool.disable();
		}
	}
}
