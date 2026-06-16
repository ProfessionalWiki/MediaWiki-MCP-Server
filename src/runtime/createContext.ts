import type { Logger } from './logger.js';
import type { ToolContext } from './context.js';
import type { AppState } from '../wikis/state.js';
import type { ProxyConfig } from '../auth/authorizationServer/proxyConfig.js';
import { WikiCacheImpl } from '../wikis/wikiCache.js';
import { SectionServiceImpl } from '../services/sectionService.js';
import { EditServiceImpl } from '../services/editService.js';
import { RevisionNormalizerImpl } from '../services/revisionNormalize.js';
import { ResponseFormatterImpl } from '../results/response.js';
import { ErrorClassifierImpl } from '../errors/classifyError.js';

export function createToolContext(deps: {
	logger: Logger;
	state: AppState;
	transport: 'http' | 'stdio';
	getProxyConfig?: () => ProxyConfig | null;
}): ToolContext {
	const { logger, state, transport, getProxyConfig } = deps;
	return {
		mwn: (wikiKey?: string) => state.mwnProvider.get(wikiKey),
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
		errors: new ErrorClassifierImpl(),
		logger,
		transport,
		getProxyConfig,
	};
}
