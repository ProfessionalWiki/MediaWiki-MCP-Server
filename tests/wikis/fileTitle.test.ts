import { describe, it, expect } from 'vitest';
import { fileTitle } from '../../src/wikis/fileTitle.ts';

describe('fileTitle', () => {
	it('puts a bare file name in the File namespace', () => {
		expect(fileTitle('Cat.jpg')).toBe('File:Cat.jpg');
	});

	it("keeps a title that names the File namespace in the wiki's language", () => {
		expect(fileTitle('Datei:Cat.jpg')).toBe('Datei:Cat.jpg');
	});

	it('keeps a title that names the File namespace in lower case', () => {
		expect(fileTitle('file:Cat.jpg')).toBe('file:Cat.jpg');
	});
});
