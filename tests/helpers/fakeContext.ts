import { vi } from 'vitest';
import type { ToolContext, ManagementContext } from '../../src/runtime/context.js';
import { ResponseFormatterImpl } from '../../src/results/response.js';
import { ErrorClassifierImpl } from '../../src/errors/classifyError.js';
import { RevisionNormalizerImpl } from '../../src/services/revisionNormalize.js';

const throws = (label: string) => () => {
	throw new Error(`fakeContext: ${label} called but not stubbed`);
};

export function fakeContext(overrides: Partial<ToolContext> = {}): ToolContext {
	return {
		mwn: throws('mwn()') as never,
		wikis: {
			getAll: throws('wikis.getAll') as never,
			get: throws('wikis.get') as never,
			add: throws('wikis.add') as never,
			remove: throws('wikis.remove') as never,
			isManagementAllowed: () => true,
		},
		selection: {
			getCurrent: () => ({
				key: 'test-wiki',
				config: {
					sitename: 'Test',
					server: 'https://test.wiki',
					articlepath: '/wiki',
					scriptpath: '/w',
					tags: null,
				} as never,
			}),
			setCurrent: throws('selection.setCurrent') as never,
			reset: throws('selection.reset') as never,
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
