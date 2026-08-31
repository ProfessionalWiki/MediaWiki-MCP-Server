import type { Logger } from './logger.ts';
import type { ToolContext } from './context.ts';
import type { AppState } from '../wikis/state.ts';
import type { ProxyConfig } from '../auth/authorizationServer/proxyConfig.ts';
import { WikiCacheImpl } from '../wikis/wikiCache.ts';
import { SectionServiceImpl } from '../services/sectionService.ts';
import { EditServiceImpl } from '../services/editService.ts';
import { RevisionNormalizerImpl } from '../services/revisionNormalize.ts';
import { ResponseFormatterImpl } from '../results/response.ts';
import { ErrorClassifierImpl } from '../errors/classifyError.ts';
import { extensionErrorVocabulary, extensionPacks } from '../tools/extensions/index.ts';
import { withCallBounds } from '../wikis/abortableMwn.ts';
import { getRequestDeadline, getRequestSignal } from './requestContext.ts';
import { callDeadline, WIKI_CALL_TIMEOUT_MS } from './callDeadline.ts';

export function createToolContext(deps: {
	logger: Logger;
	state: AppState;
	transport: 'http' | 'stdio';
	getProxyConfig?: () => ProxyConfig | null;
}): ToolContext {
	const { logger, state, transport, getProxyConfig } = deps;
	return {
		// The cached instance is shared, so bounds go on a per-request view rather
		// than on the instance. Taking the deadline from the request scope is what
		// makes a tool that acquires the wiki twice spend one budget, not two.
		mwn: async (wikiKey?: string) => {
			const bot = await state.mwnProvider.get(wikiKey);
			const deadline = getRequestDeadline() ?? callDeadline(WIKI_CALL_TIMEOUT_MS, 'calling');
			return withCallBounds(bot, deadline, getRequestSignal());
		},
		wikis: state.wikiRegistry,
		activeWiki: state.activeWiki,
		uploadDirs: state.uploadDirs,
		wikiCache: new WikiCacheImpl(state.mwnProvider, state.siteInfoCache, state.wikiProbe),
		siteInfoCache: state.siteInfoCache,
		wikiProbe: state.wikiProbe,
		sections: new SectionServiceImpl(),
		edit: new EditServiceImpl(state.activeWiki),
		revision: new RevisionNormalizerImpl(),
		format: new ResponseFormatterImpl(),
		errors: new ErrorClassifierImpl(extensionErrorVocabulary(extensionPacks)),
		logger,
		transport,
		getProxyConfig,
	};
}
