import type { Logger } from './logger.ts';
import type { SharedContext } from './context.ts';
import type { AuthPolicy } from './authShape.ts';
import type { AppState } from '../wikis/state.ts';
import { WikiCacheImpl } from '../wikis/wikiCache.ts';
import { SectionServiceImpl } from '../services/sectionService.ts';
import { EditServiceImpl } from '../services/editService.ts';
import { RevisionNormalizer } from '../services/revisionNormalize.ts';
import { ResponseFormatter } from '../results/response.ts';
import { ErrorClassifier } from '../errors/classifyError.ts';
import { extensionErrorVocabulary, extensionPacks } from '../tools/extensions/index.ts';
import { withCallBounds } from '../wikis/abortableMwn.ts';
import { getRequestDeadline, getRequestSignal } from './requestContext.ts';
import { callDeadline, WIKI_CALL_TIMEOUT_MS } from './callDeadline.ts';

export function createSharedContext(deps: {
	logger: Logger;
	state: AppState;
	auth: AuthPolicy;
}): SharedContext {
	const { logger, state, auth } = deps;
	return {
		// The cached instance is shared, so bounds go on a per-request view rather
		// than on the instance. Taking the deadline from the request scope is what
		// makes a tool that acquires the wiki twice spend one budget, not two.
		mwnFor: async (wikiKey: string) => {
			const bot = await state.mwnProvider.get(wikiKey);
			const deadline = getRequestDeadline() ?? callDeadline(WIKI_CALL_TIMEOUT_MS, 'calling');
			return withCallBounds(bot, deadline, getRequestSignal());
		},
		wikis: state.wikiRegistry,
		defaultWikiKey: state.defaultWikiKey,
		uploadDirs: state.uploadDirs,
		wikiCache: new WikiCacheImpl(state.mwnProvider, state.wikiProbe),
		wikiProbe: state.wikiProbe,
		sections: new SectionServiceImpl(),
		editFor: (wiki) => new EditServiceImpl(wiki.config.tags),
		revision: new RevisionNormalizer(),
		format: new ResponseFormatter(),
		errors: new ErrorClassifier(extensionErrorVocabulary(extensionPacks)),
		logger,
		auth,
	};
}
