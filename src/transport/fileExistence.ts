import type { ApiPage, Mwn } from 'mwn';

export class FileNotFoundError extends Error {
	public constructor(public readonly title: string) {
		super(`File "${title}" does not exist.`);
		this.name = 'FileNotFoundError';
	}
}

export async function assertFileExists(mwn: Mwn, title: string): Promise<void> {
	if (!(await fileExists(mwn, title))) {
		throw new FileNotFoundError(title);
	}
}

export async function fileExists(mwn: Mwn, title: string): Promise<boolean> {
	const fileTitle = title.startsWith('File:') ? title : `File:${title}`;

	const response = await mwn.request({
		action: 'query',
		titles: fileTitle,
		prop: 'imageinfo',
		iiprop: 'timestamp',
		formatversion: '2',
	});

	const page = (response as { query?: { pages?: ApiPage[] } }).query?.pages?.[0];

	return page !== undefined && page.missing !== true && (page.imageinfo?.length ?? 0) > 0;
}
