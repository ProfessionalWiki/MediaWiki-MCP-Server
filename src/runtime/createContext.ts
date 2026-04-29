import type { Logger } from './logger.js';
import type { ToolContext } from './context.js';
import {
	wikiRegistry,
	wikiSelection,
	uploadDirs,
	mwnProvider,
	licenseCache,
} from '../wikis/state.js';
import { WikiCacheImpl } from '../wikis/wikiCache.js';
import { SectionServiceImpl } from '../services/sectionService.js';
import { EditServiceImpl } from '../services/editService.js';
import { RevisionNormalizerImpl } from '../services/revisionNormalize.js';
import { ResponseFormatterImpl } from '../results/response.js';
import { ErrorClassifierImpl } from '../errors/classifyError.js';

export function createToolContext(deps: { logger: Logger }): ToolContext {
	return {
		mwn: (wikiKey?: string) => mwnProvider.get(wikiKey),
		wikis: wikiRegistry,
		selection: wikiSelection,
		uploadDirs,
		wikiCache: new WikiCacheImpl(mwnProvider, licenseCache),
		sections: new SectionServiceImpl(),
		edit: new EditServiceImpl(wikiSelection),
		revision: new RevisionNormalizerImpl(),
		format: new ResponseFormatterImpl(),
		errors: new ErrorClassifierImpl(),
		logger: deps.logger,
	};
}
