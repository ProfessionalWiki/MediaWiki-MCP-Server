import type { Mwn } from 'mwn';
import { wikiService } from './wikiService.js';
import { mwnProvider } from '../wikis/state.js';
import type { WikiConfig } from './config.js';

// Resolve the wiki via `wikiService` (so legacy callers — including tests that
// mock `wikiService` — observe consistent behaviour) and then delegate
// instance creation/caching to the shared `mwnProvider` singleton.
export async function getMwn( wikiKey?: string ): Promise<Mwn> {
	let key: string;
	let config: Readonly<WikiConfig> | undefined;
	if ( wikiKey !== undefined ) {
		key = wikiKey;
		config = wikiService.get( wikiKey );
		if ( !config ) {
			throw new Error( `Wiki "${ wikiKey }" not found` );
		}
	} else {
		( { key, config } = wikiService.getCurrent() );
	}
	return mwnProvider.getInstance( key, config );
}

export function removeMwnInstance( wikiKey: string ): void {
	mwnProvider.invalidate( wikiKey );
}
