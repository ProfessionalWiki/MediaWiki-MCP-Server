import { describe, it, expect } from 'vitest';
import { UploadDirsImpl } from '../../src/wikis/uploadDirs.js';

describe('UploadDirsImpl', () => {
	it('returns the configured list', () => {
		const u = new UploadDirsImpl(['/srv/uploads', '/data']);
		expect(u.list()).toEqual(['/srv/uploads', '/data']);
	});

	it('returns an empty list when constructed with []', () => {
		expect(new UploadDirsImpl([]).list()).toEqual([]);
	});
});
