import { vi, type Mock } from 'vitest';

export interface MockMwn {
	request: Mock;
	rawRequest: Mock;
	massQuery: Mock;
	getCsrfToken: Mock;
	options: { apiUrl: string; OAuth2AccessToken?: string };
	usingOAuth2: boolean;
}

export function createMockMwn(overrides: Partial<MockMwn> = {}): MockMwn {
	return {
		request: vi.fn(),
		rawRequest: vi.fn(),
		massQuery: vi.fn(),
		getCsrfToken: vi.fn(),
		options: { apiUrl: 'https://test.wiki/w/api.php' },
		usingOAuth2: false,
		...overrides,
	};
}
