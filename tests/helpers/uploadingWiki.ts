import { vi, type Mock } from 'vitest';
import type { ToolContext } from '../../src/runtime/context.ts';
import { contextWritingTo, type WritingWiki } from './writingWiki.ts';

export const UPLOADED = {
	result: 'Success',
	filename: 'Cat.jpg',
	imageinfo: {
		descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
		url: 'https://test.wiki/images/Cat.jpg',
	},
};

// The wiki's answers to an imageinfo query for a file it holds, and for one it does not.
export const FILE_EXISTS = {
	query: {
		pages: [{ title: 'File:Cat.jpg', imageinfo: [{ timestamp: '2026-01-01T00:00:00Z' }] }],
	},
};
export const FILE_MISSING = { query: { pages: [{ title: 'File:Cat.jpg', missing: true }] } };

// A context on `wiki` with the real edit service, except the multipart byte
// upload, which the fake wiki cannot read: `uploadBytes` stands in for it.
export function contextUploadingTo(
	wiki: WritingWiki,
	uploadBytes: Mock = vi.fn().mockResolvedValue(UPLOADED),
	tags: string | null = null,
): ToolContext {
	const ctx = contextWritingTo(wiki, tags);
	Object.assign(ctx.edit, { submitUploadFromBytes: uploadBytes });
	return ctx;
}
