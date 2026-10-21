import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import {
	assertFileExists,
	fileExists,
	FileNotFoundError,
} from '../../src/transport/fileExistence.ts';

function wikiAnswering(response: unknown): ReturnType<typeof createMockMwn> {
	return createMockMwn({ request: vi.fn().mockResolvedValue(response) });
}

const EXISTING_FILE = {
	query: {
		pages: [{ title: 'File:Cat.jpg', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] }],
	},
};

describe('fileExists', () => {
	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('reports a file the wiki holds as existing', async () => {
		expect(await fileExists(wikiAnswering(EXISTING_FILE) as never, 'Cat.jpg')).toBe(true);
	});

	it('reports a missing page as absent', async () => {
		const mock = wikiAnswering({
			query: { pages: [{ title: 'File:Missing.jpg', missing: true }] },
		});

		expect(await fileExists(mock as never, 'Missing.jpg')).toBe(false);
	});

	it('reports a file description page with no file as absent', async () => {
		const mock = wikiAnswering({ query: { pages: [{ title: 'File:Empty.jpg' }] } });

		expect(await fileExists(mock as never, 'Empty.jpg')).toBe(false);
	});

	it('asks for the title in the File namespace when given without the prefix', async () => {
		const mock = wikiAnswering(EXISTING_FILE);

		await fileExists(mock as never, 'Cat.jpg');

		expect(mock.request).toHaveBeenCalledWith({
			action: 'query',
			titles: 'File:Cat.jpg',
			prop: 'imageinfo',
			iiprop: 'timestamp',
			formatversion: '2',
		});
	});

	it('keeps the File: prefix when already present', async () => {
		const mock = wikiAnswering(EXISTING_FILE);

		await fileExists(mock as never, 'File:Cat.jpg');

		expect((mock.request.mock.calls[0][0] as { titles: string }).titles).toBe('File:Cat.jpg');
	});

	it('re-throws errors from the wiki', async () => {
		const mock = createMockMwn({
			request: vi.fn().mockRejectedValue(new Error('Connection refused')),
		});

		await expect(fileExists(mock as never, 'Cat.jpg')).rejects.toThrow('Connection refused');
	});
});

describe('assertFileExists', () => {
	it('resolves when the file exists', async () => {
		await expect(
			assertFileExists(wikiAnswering(EXISTING_FILE) as never, 'Cat.jpg'),
		).resolves.toBeUndefined();
	});

	it('throws FileNotFoundError naming the file when it does not exist', async () => {
		const mock = wikiAnswering({
			query: { pages: [{ title: 'File:Missing.jpg', missing: true }] },
		});

		await expect(assertFileExists(mock as never, 'Missing.jpg')).rejects.toThrow(
			new FileNotFoundError('Missing.jpg'),
		);
	});
});
