import type { Mwn } from 'mwn';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { ActiveWiki } from '../wikis/activeWiki.ts';
import type { UploadDirs } from '../wikis/uploadDirs.ts';
import type { WikiCache } from '../wikis/wikiCache.ts';
import type { SiteInfoCache } from '../wikis/siteInfoCache.ts';
import type { WikiProbe } from '../wikis/wikiProbe.ts';
import type { SectionService } from '../services/sectionService.ts';
import type { EditService } from '../services/editService.ts';
import type { RevisionNormalizer } from '../services/revisionNormalize.ts';
import type { ResponseFormatter } from '../results/response.ts';
import type { ErrorClassifier } from '../errors/classifyError.ts';
import type { ProxyConfig } from '../auth/authorizationServer/proxyConfig.ts';
import type { Logger } from './logger.ts';

export interface ToolContext {
	readonly mwn: (wikiKey?: string) => Promise<Mwn>;
	readonly wikis: WikiRegistry;
	readonly activeWiki: ActiveWiki;
	readonly uploadDirs: UploadDirs;
	readonly wikiCache: WikiCache;
	readonly siteInfoCache: SiteInfoCache;
	readonly wikiProbe: WikiProbe;
	readonly sections: SectionService;
	readonly edit: EditService;
	readonly revision: RevisionNormalizer;
	readonly format: ResponseFormatter;
	readonly errors: ErrorClassifier;
	readonly logger: Logger;
	readonly transport: 'http' | 'stdio';
	// Returns the active hosted-OAuth-proxy config, or null when the proxy is
	// disabled. Wired only on the HTTP transport (createContext.ts), so on stdio
	// and in tests it defaults to undefined (treated as "proxy disabled").
	readonly getProxyConfig?: () => ProxyConfig | null;
}

export interface ManagementContext extends ToolContext {
	readonly reconcile: () => Promise<void>;
}
