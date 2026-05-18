import { vi } from 'vitest';
import type { ToolContext, ManagementContext } from '../../src/runtime/context.js';
import { ResponseFormatterImpl } from '../../src/results/response.js';
import { ErrorClassifierImpl } from '../../src/errors/classifyError.js';
import { RevisionNormalizerImpl } from '../../src/services/revisionNormalize.js';
import { getRequestWiki } from '../../src/transport/requestContext.js';

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

export function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		mwn: throws('mwn()') as never,
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
		activeWiki: {
			get: () => {
				const key = getRequestWiki() ?? 'test-wiki';
				return { key, config: testWikiConfig as never };
			},
			getDefaultKey: () => 'test-wiki',
		},
		uploadDirs: { list: () => [] },
		wikiCache: { invalidate: throws('wikiCache.invalidate') as never },
		licenseCache: {
			get: () => undefined,
			set: () => {},
			delete: () => {},
		},
		extensions: {
			has: throws('extensions.has') as never,
			// The dispatch() capability guard calls hasAny for extension-pack
			// tools; default to "present" so plain tool tests aren't blocked.
			// Tests that exercise the guard override this explicitly.
			hasAny: (async () => true) as never,
			inspect: throws('extensions.inspect') as never,
			invalidate: throws('extensions.invalidate') as never,
		},
		sections: { list: throws('sections.list') as never },
		edit: {
			submit: throws('edit.submit') as never,
			submitUpload: throws('edit.submitUpload') as never,
			applyTags: (o) => ({ ...o }),
		},
		revision: new RevisionNormalizerImpl(),
		format: new ResponseFormatterImpl(),
		errors: new ErrorClassifierImpl(),
		logger: { info: vi.fn(), warning: vi.fn(), error: vi.fn(), debug: vi.fn() },
		transport: 'stdio' as const,
		...overrides,
	};
}

export function fakeManagementContext(
	overrides: Partial<ManagementContext> = {},
): ManagementContext {
	return { ...fakeContext(overrides), reconcile: vi.fn(), ...overrides };
}
