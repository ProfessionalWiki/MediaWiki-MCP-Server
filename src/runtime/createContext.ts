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
import { withAbortSignal } from '../wikis/abortableMwn.ts';
import { getRequestSignal } from './requestContext.ts';

export function createToolContext(deps: {
	logger: Logger;
	state: AppState;
	transport: 'http' | 'stdio';
	getProxyConfig?: () => ProxyConfig | null;
}): ToolContext {
	const { logger, state, transport, getProxyConfig } = deps;
	return {
		// The cached instance is shared across requests, so the caller's
		// cancellation signal is applied as a per-request view over it rather
		// than being set on the instance itself.
		mwn: async (wikiKey?: string) => {
			const bot = await state.mwnProvider.get(wikiKey);
			const signal = getRequestSignal();
			return signal === undefined ? bot : withAbortSignal(bot, signal);
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
		errors: new ErrorClassifierImpl(),
		logger,
		transport,
		getProxyConfig,
	};
}
