import { vi } from 'vitest';
import { dirname } from 'node:path';
import type { Mwn } from 'mwn';
import type {
	CallWiki,
	ManagementContext,
	SharedContext,
	ToolContext,
} from '../../src/runtime/context.ts';
import type { WikiConfig } from '../../src/config/loadConfig.ts';
import type { EditService } from '../../src/services/editService.ts';
import { ResponseFormatter } from '../../src/results/response.ts';
import { ErrorClassifier } from '../../src/errors/classifyError.ts';
import { extensionErrorVocabulary, extensionPacks } from '../../src/tools/extensions/index.ts';
import { RevisionNormalizer } from '../../src/services/revisionNormalize.ts';
import type { WikiIdentity, WikiProbe } from '../../src/wikis/wikiProbe.ts';
import { UploadDirsImpl, type UploadDirs } from '../../src/wikis/uploadDirs.ts';
import { fakeLogger } from './fakeLogger.ts';
import { fakeAuthPolicy } from './fakeAuthPolicy.ts';
import { StdioSignIn } from '../../src/auth/stdioSignIn.ts';
import { metricsOff } from './metrics.ts';
import type { Transport } from '../../src/runtime/authShape.ts';
import type { MockMwn } from './mock-mwn.ts';

const throws = (label: string) => () => {
	throw new Error(`fakeContext: ${label} called but not stubbed`);
};

const testWikiConfig = {
	sitename: 'Test',
	server: 'https://test.wiki',
	articlepath: '/wiki',
	scriptpath: '/w',
	tags: null,
};

// A small registry so dispatch()'s per-call wiki resolution can validate keys.
const testWikiRegistry: Record<string, typeof testWikiConfig> = {
	'test-wiki': testWikiConfig,
	'fr.wikipedia.org': testWikiConfig,
	'de.wikipedia.org': testWikiConfig,
};

/**
 * A probe that finds every wiki reachable with every pack's extension, so a pack
 * tool runs unless a test says otherwise, and reporting `identity`: with none,
 * a wiki's links use its configured server, and it has no query service, so a
 * gated tool does not run.
 */
export function probeReporting(identity: WikiIdentity): WikiProbe {
	return {
		inspect: async () => ({
			reachable: true,
			extensions: new Set(extensionPacks.flatMap((pack) => pack.extensionNames)),
			...identity,
		}),
		invalidate: throws('wikiProbe.invalidate') as never,
	};
}

/** Upload directories that take any path to be `resolved`. */
export function uploadDirsResolving(resolved: string): UploadDirs {
	return { list: () => [dirname(resolved)], resolve: () => Promise.resolve(resolved) };
}

/**
 * A context whose mwn is `mwn`. A mock stands in for the slice of mwn the tools
 * use, so it is handed over as one here, once, rather than cast in every test.
 */
export function contextOn(mwn: MockMwn | Mwn, overrides: Partial<ToolContext> = {}): ToolContext {
	return fakeContext({ mwn: async () => mwn as never, ...overrides });
}

export function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		wiki: { key: 'test-wiki', config: testWikiConfig },
		mwn: throws('mwn()') as never,
		// The dispatcher binds a call to its wiki through these, so a dispatched
		// call reaches the same stubs as one handed this context directly.
		mwnFor(): Promise<Mwn> {
			return this.mwn();
		},
		editFor(): EditService {
			return this.edit;
		},
		wikis: {
			getAll: () => testWikiRegistry as never,
			// Own-key lookup only, mirroring WikiRegistryImpl.get — a bare
			// bracket access would resolve inherited Object.prototype members.
			get: ((key: string) =>
				Object.hasOwn(testWikiRegistry, key) ? testWikiRegistry[key] : undefined) as never,
			add: throws('wikis.add') as never,
			remove: throws('wikis.remove') as never,
			isManagementAllowed: () => true,
		},
		defaultWikiKey: 'test-wiki',
		uploadDirs: new UploadDirsImpl([]),
		wikiCache: { invalidate: throws('wikiCache.invalidate') as never },
		wikiProbe: probeReporting({}),
		sections: {
			list: throws('sections.list') as never,
			listInSource: throws('sections.listInSource') as never,
		},
		edit: {
			submit: throws('edit.submit') as never,
			submitUpload: throws('edit.submitUpload') as never,
			submitUploadFromBytes: throws('edit.submitUploadFromBytes') as never,
			botRight: throws('edit.botRight') as never,
		},
		revision: new RevisionNormalizer(),
		format: new ResponseFormatter(),
		errors: new ErrorClassifier(extensionErrorVocabulary(extensionPacks)),
		logger: fakeLogger(),
		auth: fakeAuthPolicy(),
		metrics: metricsOff(),
		...overrides,
	};
}

export function fakeManagementContext(
	overrides: Partial<ManagementContext> = {},
): ManagementContext {
	return { ...fakeContext(overrides), reconcile: vi.fn(), ...overrides };
}

/** The same context, for a wiki that has turned edit attribution off. */
export function withoutEditAttribution(ctx: ToolContext): ToolContext {
	return withWikiConfig(ctx, { attributeEdits: false });
}

/** The same context, its wiki configured with `config` on top. */
export function withWikiConfig(ctx: ToolContext, config: Partial<WikiConfig>): ToolContext {
	return { ...ctx, wiki: { key: ctx.wiki.key, config: { ...ctx.wiki.config, ...config } } };
}

// A ctx whose registry and default wiki agree on one wiki — the dispatcher
// resolves and validates it before applying the OAuth gate, so a ctx whose two
// halves disagree passes only by accident.
export function ctxForWiki(config: Record<string, unknown>, transport: Transport): SharedContext {
	return ctxForWikis({ 'wiki-key': config }, 'wiki-key', transport);
}

// The same for several wikis, so a test can tell the wiki a call resolves to
// from the default.
export function ctxForWikis(
	registry: Record<string, Record<string, unknown>>,
	defaultKey: string,
	transport: Transport,
): SharedContext {
	const lookup = (key: string): Record<string, unknown> | undefined =>
		Object.hasOwn(registry, key) ? registry[key] : undefined;
	return fakeContext({
		auth: fakeAuthPolicy({
			transport,
			stdioSignIn: transport === 'stdio' ? new StdioSignIn() : null,
		}),
		wikis: {
			getAll: () => registry as never,
			get: lookup as never,
			add: () => {},
			remove: () => {},
			isManagementAllowed: () => true,
		},
		defaultWikiKey: defaultKey,
	});
}

/** The call's wiki, as the dispatcher resolves it from the registry. */
export function callWiki(ctx: SharedContext, key: string): CallWiki {
	const config = ctx.wikis.get(key);
	if (config === undefined) {
		throw new Error(`No wiki "${key}" in the test registry`);
	}
	return { key, config };
}
