import { vi, type Mock } from 'vitest';

export interface MockMwn {
	read: Mock;
	create: Mock;
	edit: Mock;
	save: Mock;
	delete: Mock;
	undelete: Mock;
	move: Mock;
	upload: Mock;
	uploadFromUrl: Mock;
	request: Mock;
	rawRequest: Mock;
	query: Mock;
	massQuery: Mock;
	getPagesByPrefix: Mock;
	getCsrfToken: Mock;
	options: { apiUrl: string; OAuth2AccessToken?: string };
	usingOAuth2: boolean;
	Category: {
		members: Mock;
	};
	cookieJar: null;
}

export function createMockMwn(overrides: Partial<MockMwn> = {}): MockMwn {
	return {
		read: vi.fn(),
		create: vi.fn(),
		edit: vi.fn(),
		save: vi.fn(),
		delete: vi.fn(),
		undelete: vi.fn(),
		move: vi.fn(),
		upload: vi.fn(),
		uploadFromUrl: vi.fn(),
		request: vi.fn(),
		rawRequest: vi.fn(),
		query: vi.fn(),
		massQuery: vi.fn(),
		getPagesByPrefix: vi.fn(),
		getCsrfToken: vi.fn(),
		options: { apiUrl: 'https://test.wiki/w/api.php' },
		usingOAuth2: false,
		Category: {
			members: vi.fn(),
		},
		cookieJar: null,
		...overrides,
	};
}
