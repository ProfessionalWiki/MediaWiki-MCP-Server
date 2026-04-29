import type { Mwn } from 'mwn';
import type { WikiRegistry } from '../wikis/wikiRegistry.js';
import type { WikiSelection } from '../wikis/wikiSelection.js';
import type { UploadDirs } from '../wikis/uploadDirs.js';
import type { WikiCache } from '../wikis/wikiCache.js';
import type { SectionService } from '../services/sectionService.js';
import type { EditService } from '../services/editService.js';
import type { RevisionNormalizer } from '../services/revisionNormalize.js';
import type { ResponseFormatter } from '../results/response.js';
import type { ErrorClassifier } from '../errors/classifyError.js';
import type { Logger } from './logger.js';

export interface ToolContext {
	readonly mwn: (wikiKey?: string) => Promise<Mwn>;
	readonly wikis: WikiRegistry;
	readonly selection: WikiSelection;
	readonly uploadDirs: UploadDirs;
	readonly wikiCache: WikiCache;
	readonly sections: SectionService;
	readonly edit: EditService;
	readonly revision: RevisionNormalizer;
	readonly format: ResponseFormatter;
	readonly errors: ErrorClassifier;
	readonly logger: Logger;
}

export interface ManagementContext extends ToolContext {
	readonly reconcile: () => void;
}
