/* eslint-disable n/no-missing-import */
import type { RegisteredTool } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */
import type { WikiConfig } from '../common/config.js';
import { wikiService } from '../common/wikiService.js';

export type Reconcile = () => void;

const WRITE_TOOL_NAMES: readonly string[] = [
	'create-page',
	'update-page',
	'delete-page',
	'undelete-page',
	'upload-file',
	'upload-file-from-url'
];

export function reconcileTools( tools: Map<string, RegisteredTool> ): void {
	const activeWiki = wikiService.getCurrent().config;
	const wikiCount = Object.keys( wikiService.getAll() ).length;
	const allowManagement = wikiService.isWikiManagementAllowed();

	applyReadOnlyRule( tools, activeWiki );
	applyWikiSetRule( tools, wikiCount, allowManagement );
}

function applyReadOnlyRule(
	tools: Map<string, RegisteredTool>,
	activeWiki: Readonly<WikiConfig>
): void {
	const shouldBeEnabled = !activeWiki.readOnly;
	for ( const name of WRITE_TOOL_NAMES ) {
		toggle( tools.get( name ), shouldBeEnabled );
	}
}

function applyWikiSetRule(
	tools: Map<string, RegisteredTool>,
	wikiCount: number,
	allowManagement: boolean
): void {
	toggle( tools.get( 'add-wiki' ), allowManagement );
	toggle( tools.get( 'remove-wiki' ), allowManagement && wikiCount >= 2 );
	toggle( tools.get( 'set-wiki' ), wikiCount >= 2 );
}

function toggle( tool: RegisteredTool | undefined, shouldBeEnabled: boolean ): void {
	if ( !tool ) {
		return;
	}
	if ( shouldBeEnabled && !tool.enabled ) {
		tool.enable();
	} else if ( !shouldBeEnabled && tool.enabled ) {
		tool.disable();
	}
}
