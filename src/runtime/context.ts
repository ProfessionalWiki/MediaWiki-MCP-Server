import type { Mwn } from 'mwn';
import type { WikiRegistry } from '../wikis/wikiRegistry.ts';
import type { UploadDirs } from '../wikis/uploadDirs.ts';
import type { WikiCache } from '../wikis/wikiCache.ts';
import type { WikiProbe } from '../wikis/wikiProbe.ts';
import type { SectionService } from '../services/sectionService.ts';
import type { EditService } from '../services/editService.ts';
import type { RevisionNormalizer } from '../services/revisionNormalize.ts';
import type { ResponseFormatter } from '../results/response.ts';
import type { ErrorClassifier } from '../errors/classifyError.ts';
import type { ProxyConfig } from '../auth/authorizationServer/proxyConfig.ts';
import type { WikiConfig } from '../config/loadConfig.ts';
import type { Logger } from './logger.ts';
import type { AuthPolicy } from './authShape.ts';

export interface CallWiki {
	readonly key: string;
	readonly config: Readonly<WikiConfig>;
}

/** What every tool call shares: the server's services, and the means to reach a wiki. */
export interface SharedContext {
	readonly mwnFor: (wikiKey: string) => Promise<Mwn>;
	readonly editFor: (wiki: CallWiki) => EditService;
	readonly wikis: WikiRegistry;
	readonly defaultWikiKey: string;
	readonly uploadDirs: UploadDirs;
	readonly wikiCache: WikiCache;
	readonly wikiProbe: WikiProbe;
	readonly sections: SectionService;
	readonly revision: RevisionNormalizer;
	readonly format: ResponseFormatter;
	readonly errors: ErrorClassifier;
	readonly logger: Logger;
	readonly transport: 'http' | 'stdio';
	readonly auth: AuthPolicy;
	// Returns the active hosted-OAuth-proxy config, or null when the proxy is
	// disabled. Wired only on the HTTP transport (createContext.ts), so on stdio
	// and in tests it defaults to undefined (treated as "proxy disabled").
	readonly getProxyConfig?: () => ProxyConfig | null;
}

/** The context of a call that acts on a wiki: that wiki, and its services. */
export interface ToolContext extends SharedContext {
	readonly wiki: CallWiki;
	readonly mwn: () => Promise<Mwn>;
	readonly edit: EditService;
}

export interface ManagementContext extends SharedContext {
	readonly reconcile: () => Promise<void>;
}
