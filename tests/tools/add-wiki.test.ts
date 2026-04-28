import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/wikis/wikiDiscovery.js', () => ({
	discoverWiki: vi.fn(),
}));

import { discoverWiki } from '../../src/wikis/wikiDiscovery.js';
import { SsrfValidationError } from '../../src/transport/ssrfGuard.js';
import { DuplicateWikiKeyError } from '../../src/wikis/wikiRegistry.js';
import { formatPayload } from '../../src/results/format.js';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.js';
import { fakeManagementContext } from '../helpers/fakeContext.js';
import { addWiki } from '../../src/tools/add-wiki.js';
import { dispatch } from '../../src/runtime/dispatcher.js';

describe('add-wiki', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('returns a structured payload on success and reconciles', async () => {
		vi.mocked(discoverWiki).mockResolvedValue({
			servername: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w',
		});

		const reconcile = vi.fn();
		const add = vi.fn();
		const ctx = fakeManagementContext({
			reconcile,
			wikis: {
				getAll: () => ({}),
				get: () => undefined,
				add,
				remove: () => {},
				isManagementAllowed: () => true,
			},
		});
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'https://example.org/' });

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({
				wikiKey: 'example.org',
				sitename: 'Example Wiki',
				server: 'https://example.org',
				articlepath: '/wiki',
				scriptpath: '/w',
			}),
		);
		expect(add).toHaveBeenCalledWith(
			'example.org',
			expect.objectContaining({
				sitename: 'Example Wiki',
				server: 'https://example.org',
				articlepath: '/wiki',
				scriptpath: '/w',
			}),
		);
		expect(reconcile).toHaveBeenCalledTimes(1);
	});

	it('categorises SSRF rejections as invalid_input', async () => {
		vi.mocked(discoverWiki).mockRejectedValue(
			new SsrfValidationError(
				'Refusing to fetch URL resolving to non-public address 169.254.169.254 (linkLocal): http://169.254.169.254/',
			),
		);

		const reconcile = vi.fn();
		const ctx = fakeManagementContext({ reconcile });
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'http://169.254.169.254/' });

		const envelope = assertStructuredError(result, 'invalid_input');
		expect(envelope.message).toMatch(/Failed to add wiki:.*169\.254\.169\.254/);
		expect(reconcile).not.toHaveBeenCalled();
	});

	it('categorises duplicate-wiki-key failures as conflict', async () => {
		vi.mocked(discoverWiki).mockResolvedValue({
			servername: 'example.org',
			sitename: 'Example',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w',
		});

		const reconcile = vi.fn();
		const add = vi.fn().mockImplementation(() => {
			throw new DuplicateWikiKeyError('example.org');
		});
		const ctx = fakeManagementContext({
			reconcile,
			wikis: {
				getAll: () => ({}),
				get: () => undefined,
				add,
				remove: () => {},
				isManagementAllowed: () => true,
			},
		});
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'https://example.org/' });

		const envelope = assertStructuredError(result, 'conflict');
		expect(envelope.message).toBe('Wiki "example.org" already exists in configuration');
		expect(reconcile).not.toHaveBeenCalled();
	});

	it('categorises unexpected discoverWiki errors as upstream_failure', async () => {
		vi.mocked(discoverWiki).mockRejectedValue(new Error('Connection refused'));

		const reconcile = vi.fn();
		const ctx = fakeManagementContext({ reconcile });
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'https://example.org/' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toMatch(/Failed to add wiki: Connection refused/);
		expect(reconcile).not.toHaveBeenCalled();
	});

	it('does not call reconcile on the DuplicateWikiKeyError path', async () => {
		vi.mocked(discoverWiki).mockResolvedValue({
			servername: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w',
		});

		const reconcile = vi.fn();
		const add = vi.fn().mockImplementation(() => {
			throw new DuplicateWikiKeyError('example.org');
		});
		const ctx = fakeManagementContext({
			reconcile,
			wikis: {
				getAll: () => ({}),
				get: () => undefined,
				add,
				remove: () => {},
				isManagementAllowed: () => true,
			},
		});
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'https://example.org/' });

		assertStructuredError(result, 'conflict');
		expect(reconcile).not.toHaveBeenCalled();
	});

	it('does not call reconcile on the SsrfValidationError path', async () => {
		vi.mocked(discoverWiki).mockRejectedValue(new SsrfValidationError('rejected'));

		const reconcile = vi.fn();
		const ctx = fakeManagementContext({ reconcile });
		const result = await dispatch(addWiki, ctx)({ wikiUrl: 'https://example.org/' });

		assertStructuredError(result, 'invalid_input');
		expect(reconcile).not.toHaveBeenCalled();
	});
});
