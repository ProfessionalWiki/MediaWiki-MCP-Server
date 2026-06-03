import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { EditServiceImpl } from '../../src/services/editService.js';
import type { ActiveWiki } from '../../src/wikis/activeWiki.js';

const fakeActiveWiki = (tags: string | string[] | null = null): ActiveWiki => ({
	get: () => ({
		key: 'k',
		config: {
			server: 's',
			articlepath: '/wiki',
			scriptpath: '/w',
			tags,
			sitename: 'S',
		} as never,
	}),
	getDefaultKey: () => 'k',
});

describe('EditServiceImpl', () => {
	it('submit injects token, formatversion=2, and tags', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('CSRFTOKEN'),
			request: vi.fn().mockResolvedValue({ ok: true }),
		});
		const edit = new EditServiceImpl(fakeActiveWiki('mcp-edit'));
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
		const edit = new EditServiceImpl(fakeActiveWiki(null));
		await edit.submit(mock as never, { action: 'edit' });
		expect(mock.request).toHaveBeenCalledWith({
			action: 'edit',
			token: 'CSRFTOKEN',
			formatversion: '2',
		});
	});

	it('applyTags returns options unchanged when tags is null', () => {
		const edit = new EditServiceImpl(fakeActiveWiki(null));
		const options = { reason: 'spam' };
		expect(edit.applyTags(options)).toEqual({ reason: 'spam' });
	});

	it('applyTags adds tags when configured', () => {
		const edit = new EditServiceImpl(fakeActiveWiki(['mcp-edit']));
		expect(edit.applyTags({ reason: 'spam' })).toEqual({
			reason: 'spam',
			tags: ['mcp-edit'],
		});
	});

	it('applyTags returns a copy and does not mutate input', () => {
		const edit = new EditServiceImpl(fakeActiveWiki('mcp-edit'));
		const input = { reason: 'spam' };
		const result = edit.applyTags(input);
		expect(result).not.toBe(input);
		expect(input).toEqual({ reason: 'spam' });
	});

	it('submitUpload injects tags into upload params', async () => {
		const mock = createMockMwn({
			upload: vi.fn().mockResolvedValue({ filename: 'F.png' }),
		});
		const edit = new EditServiceImpl(fakeActiveWiki('mcp-upload'));
		await edit.submitUpload(mock as never, '/tmp/f', 'File:F.png', 'desc', { comment: 'c' });
		expect(mock.upload).toHaveBeenCalledWith('/tmp/f', 'File:F.png', 'desc', {
			comment: 'c',
			tags: 'mcp-upload',
		});
	});

	it('submitUploadFromBytes posts a multipart upload with token, tags, and ignorewarnings', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('CSRFTOKEN'),
			request: vi.fn().mockResolvedValue({ upload: { result: 'Success', filename: 'F.png' } }),
		});
		const edit = new EditServiceImpl(fakeActiveWiki('mcp-upload'));
		const result = await edit.submitUploadFromBytes(
			mock as never,
			Buffer.from('bytes'),
			'F.png',
			'File:F.png',
			'desc',
			{ comment: 'c' },
		);
		expect(result).toEqual({ result: 'Success', filename: 'F.png' });
		const [params, opts] = mock.request.mock.calls[0];
		expect(params).toMatchObject({
			action: 'upload',
			filename: 'File:F.png',
			text: 'desc',
			comment: 'c',
			ignorewarnings: true,
			token: 'CSRFTOKEN',
			tags: 'mcp-upload',
		});
		expect(params.file).toMatchObject({ name: 'F.png' });
		// The file part must be a Buffer — form-data rejects a plain Readable
		// (no known length) with "Unknown stream" at request time.
		expect(Buffer.isBuffer(params.file.stream)).toBe(true);
		expect(opts).toEqual({ headers: { 'Content-Type': 'multipart/form-data' } });
	});
});
