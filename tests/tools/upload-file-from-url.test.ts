import { describe, it, expect, vi, beforeEach } from 'vitest';
import { z } from 'zod';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn()
} ) );

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		getCurrent: vi.fn().mockReturnValue( {
			key: 'test-wiki',
			config: { server: 'https://test.wiki', articlepath: '/wiki', scriptpath: '/w' }
		} )
	}
} ) );

import { getMwn } from '../../src/common/mwn.js';
import { formatPayload } from '../../src/common/formatPayload.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'upload-file-from-url', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'returns a structured payload on success', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUploadFileFromUrlTool } = await import( '../../src/tools/upload-file-from-url.js' );
		const result = await handleUploadFileFromUrlTool(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);

		const text = assertStructuredSuccess( result );
		expect( text ).toBe( formatPayload( {
			filename: 'Cat.jpg',
			pageUrl: 'https://test.wiki/wiki/File:Cat.jpg',
			fileUrl: 'https://test.wiki/images/Cat.jpg'
		} ) );
	} );

	it( 'surfaces copyuploaddisabled as invalid_input with a remedy hint', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue(
				createMockMwnError(
					'copyuploaddisabled',
					'copyuploaddisabled: Uploads by URL are disabled on this wiki.'
				)
			)
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUploadFileFromUrlTool } = await import( '../../src/tools/upload-file-from-url.js' );
		const result = await handleUploadFileFromUrlTool(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);

		const envelope = assertStructuredError( result, 'invalid_input', 'copyuploaddisabled' );
		expect( envelope.message ).toMatch(
			/Upload by URL is disabled/
		);
	} );

	it( 'categorises generic upstream failures as upstream_failure', async () => {
		const mock = createMockMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( new Error( 'Connection refused' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as unknown as Awaited<ReturnType<typeof getMwn>> );

		const { handleUploadFileFromUrlTool } = await import( '../../src/tools/upload-file-from-url.js' );
		const result = await handleUploadFileFromUrlTool(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toMatch(
			/Failed to upload file: Connection refused/
		);
	} );
} );
