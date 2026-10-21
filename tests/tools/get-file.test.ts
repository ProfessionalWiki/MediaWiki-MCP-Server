import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { fakeContext } from '../helpers/fakeContext.ts';
import { getFile } from '../../src/tools/get-file.ts';
import { dispatch } from '../../src/runtime/dispatcher.ts';
import { formatPayload } from '../../src/results/format.ts';
import { assertStructuredError, assertStructuredSuccess } from '../helpers/structuredResult.ts';

describe('get-file', () => {
	it('returns file info using action=query&prop=imageinfo', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							title: 'File:Example.png',
							imageinfo: [
								{
									url: 'https://test.wiki/images/example.png',
									descriptionurl: 'https://test.wiki/wiki/File:Example.png',
									size: 12345,
									width: 800,
									height: 600,
									mime: 'image/png',
									timestamp: '2026-01-01T00:00:00Z',
									user: 'Admin',
									thumburl: 'https://test.wiki/images/thumb/example.png/200px-example.png',
								},
							],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFile.handle({ title: 'Example.png' }, ctx);

		const text = assertStructuredSuccess(result);
		expect(text).toBe(
			formatPayload({
				title: 'File:Example.png',
				descriptionUrl: 'https://test.wiki/wiki/File:Example.png',
				timestamp: '2026-01-01T00:00:00Z',
				user: 'Admin',
				size: 12345,
				mime: 'image/png',
				url: 'https://test.wiki/images/example.png',
				thumbnailUrl: 'https://test.wiki/images/thumb/example.png/200px-example.png',
			}),
		);
	});

	it("looks up a title with a File prefix in the wiki's language as given", async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({ query: { pages: [{ title: 'Datei:Example.png' }] } }),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		await getFile.handle({ title: 'Datei:Example.png' }, ctx);

		expect((mock.request.mock.calls[0][0] as { titles: string }).titles).toBe('Datei:Example.png');
	});

	it('returns a file the wiki serves from a shared repository such as Commons', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							title: 'File:Example.jpg',
							missing: true,
							known: true,
							imagerepository: 'shared',
							imageinfo: [
								{
									url: 'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg',
									descriptionurl: 'https://commons.wikimedia.org/wiki/File:Example.jpg',
									mime: 'image/jpeg',
								},
							],
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFile.handle({ title: 'Example.jpg' }, ctx);

		expect(assertStructuredSuccess(result)).toContain(
			'https://upload.wikimedia.org/wikipedia/commons/a/a9/Example.jpg',
		);
	});

	it('handles missing files', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockResolvedValue({
				query: {
					pages: [
						{
							title: 'File:Missing.png',
							missing: true,
						},
					],
				},
			}),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await getFile.handle({ title: 'Missing.png' }, ctx);

		const envelope = assertStructuredError(result, 'not_found');
		expect(envelope.message).toContain('not found');
	});

	it('returns error on API failure via dispatcher', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('API error')),
		});
		const ctx = fakeContext({ mwn: async () => mock as never });

		const result = await dispatch(getFile, ctx)({ title: 'Example.png' });

		const envelope = assertStructuredError(result, 'upstream_failure');
		expect(envelope.message).toContain('API error');
	});
});
