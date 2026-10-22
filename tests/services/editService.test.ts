import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.ts';
import { UPLOADED } from '../helpers/uploadingWiki.ts';
import { writingWiki } from '../helpers/writingWiki.ts';
import { EditServiceImpl } from '../../src/services/editService.ts';

describe('EditServiceImpl', () => {
	it('submit injects token, formatversion=2, and tags', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('CSRFTOKEN'),
			request: vi.fn().mockResolvedValue({ ok: true }),
		});
		const edit = new EditServiceImpl('mcp-edit');
		await edit.submit(mock as never, { action: 'edit', title: 'Foo', text: 'bar' });
		expect(mock.request).toHaveBeenCalledWith({
			action: 'edit',
			title: 'Foo',
			text: 'bar',
			token: 'CSRFTOKEN',
			formatversion: '2',
			tags: 'mcp-edit',
		});
	});

	it('submit omits tags when not configured', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('CSRFTOKEN'),
			request: vi.fn().mockResolvedValue({}),
		});
		const edit = new EditServiceImpl(null);
		await edit.submit(mock as never, { action: 'edit' });
		expect(mock.request).toHaveBeenCalledWith({
			action: 'edit',
			token: 'CSRFTOKEN',
			formatversion: '2',
		});
	});

	describe('submitUpload', () => {
		const BAD_TOKEN = { error: { code: 'badtoken', info: 'Invalid CSRF token.' } };
		let dir: string;
		let catFile: string;

		beforeAll(async () => {
			dir = await mkdtemp(join(tmpdir(), 'mcp-upload-'));
			catFile = join(dir, 'cat.jpg');
			await writeFile(catFile, 'cat bytes');
		});

		afterAll(async () => {
			await rm(dir, { recursive: true, force: true });
		});

		it('sends the file with its title, text, a CSRF token, the params and the configured tags, ignoring warnings', async () => {
			const wiki = writingWiki({ upload: UPLOADED });
			const edit = new EditServiceImpl('mcp-upload');

			await edit.submitUpload(wiki.mwn, catFile, 'File:Cat.jpg', 'A cat.', { comment: 'c' });

			expect(Object.fromEntries(wiki.sentWrite())).toMatchObject({
				file: 'cat bytes',
				filename: 'File:Cat.jpg',
				text: 'A cat.',
				comment: 'c',
				token: 'csrf-token',
				tags: 'mcp-upload',
				ignorewarnings: '1',
			});
		});

		it('sends no tags when the wiki configures none', async () => {
			const wiki = writingWiki({ upload: UPLOADED });
			const edit = new EditServiceImpl(null);

			await edit.submitUpload(wiki.mwn, catFile, 'File:Cat.jpg', 'A cat.', {});

			expect(wiki.sentWrite().has('tags')).toBe(false);
		});

		it('sends the whole file again when the wiki asks for a fresh token', async () => {
			const wiki = writingWiki([BAD_TOKEN, { upload: UPLOADED }]);
			const edit = new EditServiceImpl(null);

			await edit.submitUpload(wiki.mwn, catFile, 'File:Cat.jpg', 'A cat.', {});

			expect(wiki.writes[1].get('file')).toBe('cat bytes');
		});
	});

	describe('botRight', () => {
		it('returns true when userinfo rights include bot', async () => {
			const mock = createMockMwn({
				request: vi
					.fn()
					.mockResolvedValue({ query: { userinfo: { rights: ['edit', 'bot', 'read'] } } }),
			});
			const edit = new EditServiceImpl(null);
			await expect(edit.botRight(mock as never)).resolves.toBe(true);
			expect(mock.request).toHaveBeenCalledWith({
				action: 'query',
				meta: 'userinfo',
				uiprop: 'rights',
				formatversion: '2',
			});
		});

		it('returns false when userinfo rights lack bot', async () => {
			const mock = createMockMwn({
				request: vi.fn().mockResolvedValue({ query: { userinfo: { rights: ['edit', 'read'] } } }),
			});
			const edit = new EditServiceImpl(null);
			await expect(edit.botRight(mock as never)).resolves.toBe(false);
		});

		it('caches the probe per Mwn instance, across edit services', async () => {
			const request = vi.fn().mockResolvedValue({ query: { userinfo: { rights: ['bot'] } } });
			const mock = createMockMwn({ request });
			await new EditServiceImpl(null).botRight(mock as never);
			await new EditServiceImpl(null).botRight(mock as never);
			expect(request).toHaveBeenCalledTimes(1);
		});

		it('resolves undefined when the probe fails, and retries on the next call', async () => {
			const request = vi
				.fn()
				.mockRejectedValueOnce(new Error('network down'))
				.mockResolvedValueOnce({ query: { userinfo: { rights: ['bot'] } } });
			const mock = createMockMwn({ request });
			const edit = new EditServiceImpl(null);
			await expect(edit.botRight(mock as never)).resolves.toBeUndefined();
			await expect(edit.botRight(mock as never)).resolves.toBe(true);
			expect(request).toHaveBeenCalledTimes(2);
		});
	});

	it('submitUploadFromBytes sends the bytes with their title, text, a CSRF token, the params and the configured tags', async () => {
		const wiki = writingWiki({ upload: UPLOADED });
		const edit = new EditServiceImpl('mcp-upload');

		await edit.submitUploadFromBytes(
			wiki.mwn,
			Buffer.from('cat bytes'),
			'cat.jpg',
			'File:Cat.jpg',
			'A cat.',
			{ comment: 'c' },
		);

		expect(Object.fromEntries(wiki.sentWrite())).toMatchObject({
			file: 'cat bytes',
			filename: 'File:Cat.jpg',
			text: 'A cat.',
			comment: 'c',
			token: 'csrf-token',
			tags: 'mcp-upload',
			ignorewarnings: '1',
		});
	});

	it('returns the upload the wiki reports', async () => {
		const wiki = writingWiki({ upload: UPLOADED });
		const edit = new EditServiceImpl(null);

		const result = await edit.submitUploadFromBytes(
			wiki.mwn,
			Buffer.from('cat bytes'),
			'cat.jpg',
			'File:Cat.jpg',
			'',
			{},
		);

		expect(result).toEqual(UPLOADED);
	});
});
