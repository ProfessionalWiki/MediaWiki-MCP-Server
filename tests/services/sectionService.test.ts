import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { SectionServiceImpl } from '../../src/services/sectionService.js';

describe( 'SectionServiceImpl', () => {
	it( 'returns lead-empty plus heading lines', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: {
					sections: [
						{ line: 'Heading One' },
						{ line: 'Heading Two' }
					]
				}
			} )
		} );
		const sections = new SectionServiceImpl();
		const result = await sections.list( mock as never, 'Foo' );
		expect( result ).toEqual( [ '', 'Heading One', 'Heading Two' ] );
		expect( mock.request ).toHaveBeenCalledWith( {
			action: 'parse', page: 'Foo', prop: 'sections', formatversion: '2'
		} );
	} );

	it( 'returns just lead when there are no sections', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		const sections = new SectionServiceImpl();
		expect( await sections.list( mock as never, 'Empty' ) ).toEqual( [ '' ] );
	} );
} );
