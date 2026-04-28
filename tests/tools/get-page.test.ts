import { describe, it, expect, vi } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { getPage } from '../../src/tools/get-page.js';
import { dispatch } from '../../src/runtime/dispatcher.js';
import { ContentFormat } from '../../src/results/contentFormat.js';
import { SectionServiceImpl } from '../../src/services/sectionService.js';
import {
	assertStructuredError,
	assertStructuredSuccess
} from '../helpers/structuredResult.js';

describe( 'get-page', () => {
	it( 'returns page source using mwn.read()', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: 'Hello world'
				} ]
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: false
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Source: Hello world' );
		expect( text ).not.toContain( 'Page ID:' );
		expect( text ).not.toContain( 'Title:' );
		expect( mock.read ).toHaveBeenCalledWith( 'Test Page', expect.any( Object ) );
	} );

	it( 'returns HTML using action=parse', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>' }
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.html,
			metadata: false
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
	} );

	it( 'returns metadata without content for ContentFormat.none', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.none,
			metadata: true
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Title: Test Page' );
		expect( text ).toContain( 'Latest revision ID: 42' );
		expect( text ).toContain( 'Content model: wikitext' );
		expect( text ).not.toContain( 'Source:' );
		expect( text ).not.toContain( 'HTML:' );
	} );

	it( 'returns error when page is missing', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 0,
				title: 'Missing Page',
				missing: true
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Missing Page',
			content: ContentFormat.source,
			metadata: false
		}, ctx );

		const envelope = assertStructuredError( result, 'not_found' );
		expect( envelope.message ).toContain( 'not found' );
	} );

	it( 'returns both metadata and source when both requested', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: 'Hello world'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: true
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'Source: Hello world' );
	} );

	it( 'returns error on mwn failure via dispatcher', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockRejectedValue( new Error( 'API error' ) )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await dispatch( getPage, ctx )( {
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: false
		} );

		const envelope = assertStructuredError( result, 'upstream_failure' );
		expect( envelope.message ).toContain( 'API error' );
	} );

	it( 'forwards section as rvsection for source content', async () => {
		const read = vi.fn().mockResolvedValue( {
			pageid: 1,
			title: 'Test Page',
			revisions: [ {
				revid: 42,
				timestamp: '2026-01-01T00:00:00Z',
				contentmodel: 'wikitext',
				content: 'Section body'
			} ]
		} );
		const mock = createMockMwn( { read } );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: false,
			section: 2
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Source: Section body' );
		expect( read ).toHaveBeenCalledWith( 'Test Page', expect.objectContaining( {
			rvsection: 2
		} ) );
	} );

	it( 'forwards section as parse section for html content', async () => {
		const request = vi.fn().mockResolvedValue( {
			parse: { text: '<p>Section HTML</p>' }
		} );
		const mock = createMockMwn( { request } );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.html,
			metadata: false,
			section: 1
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'HTML: <p>Section HTML</p>' );
		expect( request ).toHaveBeenCalledWith( expect.objectContaining( {
			action: 'parse',
			page: 'Test Page',
			section: 1
		} ) );
	} );

	it( 'rejects section with content="none"', async () => {
		const ctx = fakeContext();

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.none,
			metadata: true,
			section: 2
		}, ctx );

		const envelope = assertStructuredError( result, 'invalid_input' );
		expect( envelope.message ).toContain( 'section is not compatible with content="none"' );
	} );

	it( 'reports the full-page size in metadata even when section is set', async () => {
		const read = vi.fn().mockResolvedValue( {
			pageid: 1,
			title: 'Test Page',
			revisions: [ {
				revid: 42,
				timestamp: '2026-01-01T00:00:00Z',
				contentmodel: 'wikitext',
				size: 98765,
				content: 'Section body'
			} ]
		} );
		const request = vi.fn().mockResolvedValue( {
			parse: { sections: [ { line: 'History' } ] }
		} );
		const mock = createMockMwn( { read, request } );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.source,
			metadata: true,
			section: 1
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Size: 98765' );
		expect( read ).toHaveBeenCalledWith( 'Test Page', expect.objectContaining( {
			rvsection: 1
		} ) );
	} );

	it( 'omits size from metadata when the revision has no size field', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'No Size',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn().mockResolvedValue( { parse: { sections: [] } } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'No Size',
			content: ContentFormat.none,
			metadata: true
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).not.toContain( 'Size:' );
	} );

	it( 'metadata=true includes size and sections array (lead slot is empty string)', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					size: 12345
				} ]
			} ),
			request: vi.fn().mockResolvedValue( {
				parse: {
					sections: [
						{ line: 'History', number: '1', index: '1' },
						{ line: 'Background', number: '2', index: '2' }
					]
				}
			} )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.none,
			metadata: true
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toContain( 'Size: 12345' );
		expect( text ).toContain( 'Sections:\n- (empty)\n- History\n- Background' );
	} );

	it( 'attaches content-truncated truncation when source exceeds the byte cap', async () => {
		const big = 'x'.repeat( 50001 );
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Big',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: big
				} ]
			} ),
			request: vi.fn().mockResolvedValue( {
				parse: { sections: [ { line: 'History' } ] }
			} )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Big',
			content: ContentFormat.source,
			metadata: false
		}, ctx );

		const text = assertStructuredSuccess( result );
		// Source body is ~50000 chars, rendered as long-string block after Source: label.
		expect( text ).toMatch( /Source:\n\nx{50000}/ );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Total bytes: 50001' );
		expect( text ).toContain( '  Item noun: wikitext' );
		expect( text ).toContain( '  Tool name: get-page' );
		expect( text ).toContain( '  Sections:\n  - (empty)\n  - History' );
	} );

	it( 'omits truncation when source is exactly at the byte cap', async () => {
		const exact = 'y'.repeat( 50000 );
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Exact',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext',
					content: exact
				} ]
			} )
		} );
		const ctx = fakeContext( { mwn: async () => mock as never } );

		const result = await getPage.handle( {
			title: 'Exact',
			content: ContentFormat.source,
			metadata: false
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( text ).toMatch( /Source:\n\ny{50000}/ );
		expect( text ).not.toContain( 'Truncation:' );
	} );

	it( 'attaches content-truncated truncation when HTML exceeds the byte cap', async () => {
		const bigHtml = '<p>' + 'x'.repeat( 60000 ) + '</p>';
		const request = vi.fn()
			.mockResolvedValueOnce( { parse: { text: bigHtml } } )
			.mockResolvedValueOnce( { parse: { sections: [ { line: 'Heading' } ] } } );
		const mock = createMockMwn( { request } );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Huge',
			content: ContentFormat.html,
			metadata: false
		}, ctx );

		const text = assertStructuredSuccess( result );
		// Truncated HTML is rendered as long-string block.
		expect( text ).toMatch( /HTML:\n\n<p>x+/ );
		expect( text ).toContain( 'Truncation:' );
		expect( text ).toContain( '  Reason: content-truncated' );
		expect( text ).toContain( '  Returned bytes: 50000' );
		expect( text ).toContain( '  Item noun: HTML' );
		expect( text ).toContain( '  Tool name: get-page' );
		expect( text ).toContain( '  Sections:\n  - (empty)\n  - Heading' );
	} );

	it( 'html+metadata calls read once and returns both metadata and html', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockResolvedValue( {
				pageid: 1,
				title: 'Test Page',
				revisions: [ {
					revid: 42,
					timestamp: '2026-01-01T00:00:00Z',
					contentmodel: 'wikitext'
				} ]
			} ),
			request: vi.fn()
				.mockResolvedValueOnce( { parse: { sections: [] } } )
				.mockResolvedValueOnce( { parse: { text: '<p>Hello</p>' } } )
		} );
		const ctx = fakeContext( {
			mwn: async () => mock as never,
			sections: new SectionServiceImpl()
		} );

		const result = await getPage.handle( {
			title: 'Test Page',
			content: ContentFormat.html,
			metadata: true
		}, ctx );

		const text = assertStructuredSuccess( result );
		expect( mock.read ).toHaveBeenCalledTimes( 1 );
		expect( text ).toContain( 'Page ID: 1' );
		expect( text ).toContain( 'HTML: <p>Hello</p>' );
	} );
} );
