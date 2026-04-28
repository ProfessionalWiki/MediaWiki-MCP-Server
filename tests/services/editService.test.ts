import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { EditServiceImpl } from '../../src/services/editService.js';
import type { WikiSelection } from '../../src/wikis/wikiSelection.js';

const fakeSelection = (tags: string | string[] | null = null): WikiSelection => ({
	getCurrent: () => ({
		key: 'k',
		config: {
			server: 's',
			articlepath: '/wiki',
			scriptpath: '/w',
			tags,
			sitename: 'S',
		} as never,
	}),
	setCurrent: () => {
		throw new Error('unused');
	},
	reset: () => {
		throw new Error('unused');
	},
});

describe('EditServiceImpl', () => {
	it('submit injects token, formatversion=2, and tags', async () => {
		const mock = createMockMwn({
			getCsrfToken: vi.fn().mockResolvedValue('CSRFTOKEN'),
			request: vi.fn().mockResolvedValue({ ok: true }),
		});
		const edit = new EditServiceImpl(fakeSelection('mcp-edit'));
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
		const edit = new EditServiceImpl(fakeSelection(null));
		await edit.submit(mock as never, { action: 'edit' });
		expect(mock.request).toHaveBeenCalledWith({
			action: 'edit',
			token: 'CSRFTOKEN',
			formatversion: '2',
		});
	});

	it('applyTags returns options unchanged when tags is null', () => {
		const edit = new EditServiceImpl(fakeSelection(null));
		const options = { reason: 'spam' };
		expect(edit.applyTags(options)).toEqual({ reason: 'spam' });
	});

	it('applyTags adds tags when configured', () => {
		const edit = new EditServiceImpl(fakeSelection(['mcp-edit']));
		expect(edit.applyTags({ reason: 'spam' })).toEqual({
			reason: 'spam',
			tags: ['mcp-edit'],
		});
	});

	it('applyTags returns a copy and does not mutate input', () => {
		const edit = new EditServiceImpl(fakeSelection('mcp-edit'));
		const input = { reason: 'spam' };
		const result = edit.applyTags(input);
		expect(result).not.toBe(input);
		expect(input).toEqual({ reason: 'spam' });
	});

	it('submitUpload injects tags into upload params', async () => {
		const mock = createMockMwn({
			upload: vi.fn().mockResolvedValue({ filename: 'F.png' }),
		});
		const edit = new EditServiceImpl(fakeSelection('mcp-upload'));
		await edit.submitUpload(mock as never, '/tmp/f', 'File:F.png', 'desc', { comment: 'c' });
		expect(mock.upload).toHaveBeenCalledWith('/tmp/f', 'File:F.png', 'desc', {
			comment: 'c',
			tags: 'mcp-upload',
		});
	});
});
