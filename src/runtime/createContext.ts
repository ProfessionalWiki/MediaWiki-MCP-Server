import type { Logger } from './logger.js';
import type { ToolContext } from './context.js';
import type { AppState } from '../wikis/state.js';
import { WikiCacheImpl } from '../wikis/wikiCache.js';
import { SectionServiceImpl } from '../services/sectionService.js';
import { EditServiceImpl } from '../services/editService.js';
import { RevisionNormalizerImpl } from '../services/revisionNormalize.js';
import { ResponseFormatterImpl } from '../results/response.js';
import { ErrorClassifierImpl } from '../errors/classifyError.js';

export function createToolContext(deps: { logger: Logger; state: AppState }): ToolContext {
	const { logger, state } = deps;
	return {
		mwn: (wikiKey?: string) => state.mwnProvider.get(wikiKey),
		wikis: state.wikiRegistry,
		selection: state.wikiSelection,
		uploadDirs: state.uploadDirs,
		wikiCache: new WikiCacheImpl(state.mwnProvider, state.licenseCache),
		licenseCache: state.licenseCache,
		sections: new SectionServiceImpl(),
		edit: new EditServiceImpl(state.wikiSelection),
		revision: new RevisionNormalizerImpl(),
		format: new ResponseFormatterImpl(),
		errors: new ErrorClassifierImpl(),
		logger,
	};
}
