import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn()
} ) );

import { getMwn } from '../../src/common/mwn.js';

describe( 'assertFileExists', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'resolves when the file exists with at least one imageinfo entry', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ {
					title: 'File:Cat.jpg',
					imageinfo: [ { timestamp: '2026-01-01T00:00:00Z' } ]
				} ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists } = await import( '../../src/common/fileExistence.js' );
		await expect( assertFileExists( 'Cat.jpg' ) ).resolves.toBeUndefined();
	} );

	it( 'prefixes File: when the title lacks it', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ {
					title: 'File:Cat.jpg',
					imageinfo: [ { timestamp: '2026-01-01T00:00:00Z' } ]
				} ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists } = await import( '../../src/common/fileExistence.js' );
		await assertFileExists( 'Cat.jpg' );

		expect( mock.request ).toHaveBeenCalledWith( {
			action: 'query',
			titles: 'File:Cat.jpg',
			prop: 'imageinfo',
			iiprop: 'timestamp',
			formatversion: '2'
		} );
	} );

	it( 'preserves the File: prefix when already present', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ {
					title: 'File:Cat.jpg',
					imageinfo: [ { timestamp: '2026-01-01T00:00:00Z' } ]
				} ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists } = await import( '../../src/common/fileExistence.js' );
		await assertFileExists( 'File:Cat.jpg' );

		expect( ( mock.request.mock.calls[ 0 ][ 0 ] as { titles: string } ).titles ).toBe(
			'File:Cat.jpg'
		);
	} );

	it( 'throws FileNotFoundError when the page is missing', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { title: 'File:Missing.jpg', missing: true } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists, FileNotFoundError } = await import(
			'../../src/common/fileExistence.js'
		);
		await expect( assertFileExists( 'Missing.jpg' ) ).rejects.toThrow( FileNotFoundError );
		await expect( assertFileExists( 'Missing.jpg' ) ).rejects.toThrow( /Missing\.jpg/ );
	} );

	it( 'throws FileNotFoundError when the page exists but has no imageinfo', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { title: 'File:Empty.jpg' } ] }
			} )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists, FileNotFoundError } = await import(
			'../../src/common/fileExistence.js'
		);
		await expect( assertFileExists( 'Empty.jpg' ) ).rejects.toThrow( FileNotFoundError );
	} );

	it( 're-throws non-missing errors from mwn.request', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( new Error( 'Connection refused' ) )
		} );
		vi.mocked( getMwn ).mockResolvedValue( mock as any );

		const { assertFileExists } = await import( '../../src/common/fileExistence.js' );
		await expect( assertFileExists( 'Cat.jpg' ) ).rejects.toThrow( 'Connection refused' );
	} );
} );
