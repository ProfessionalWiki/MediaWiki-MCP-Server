import { vi } from 'vitest';

export interface MockMwn {
	read: ReturnType<typeof vi.fn>;
	create: ReturnType<typeof vi.fn>;
	edit: ReturnType<typeof vi.fn>;
	save: ReturnType<typeof vi.fn>;
	delete: ReturnType<typeof vi.fn>;
	undelete: ReturnType<typeof vi.fn>;
	upload: ReturnType<typeof vi.fn>;
	uploadFromUrl: ReturnType<typeof vi.fn>;
	request: ReturnType<typeof vi.fn>;
	query: ReturnType<typeof vi.fn>;
	getPagesByPrefix: ReturnType<typeof vi.fn>;
	getCsrfToken: ReturnType<typeof vi.fn>;
	Category: {
		members: ReturnType<typeof vi.fn>;
	};
	cookieJar: null;
}

export function createMockMwn( overrides: Partial<MockMwn> = {} ): MockMwn {
	return {
		read: vi.fn(),
		create: vi.fn(),
		edit: vi.fn(),
		save: vi.fn(),
		delete: vi.fn(),
		undelete: vi.fn(),
		upload: vi.fn(),
		uploadFromUrl: vi.fn(),
		request: vi.fn(),
		query: vi.fn(),
		getPagesByPrefix: vi.fn(),
		getCsrfToken: vi.fn(),
		Category: {
			members: vi.fn()
		},
		cookieJar: null,
		...overrides
	};
}
