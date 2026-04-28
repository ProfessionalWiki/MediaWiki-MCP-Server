/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createMockMwn } from '../helpers/mock-mwn.js';
import { createMockMwnError } from '../helpers/mock-mwn-error.js';

// Mocks for the common modules.
// These are hoisted by vi.mock so they apply before any source import below.

vi.mock( '../../src/common/mwn.js', () => ( {
	getMwn: vi.fn(),
	removeMwnInstance: vi.fn()
} ) );

vi.mock( '../../src/common/wikiService.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/wikiService.js' )>(
		'../../src/common/wikiService.js'
	);
	return {
		...actual,
		wikiService: {
			getCurrent: vi.fn().mockReturnValue( {
				key: 'test-wiki',
				config: {
					sitename: 'Test',
					server: 'https://test.wiki',
					articlepath: '/wiki',
					scriptpath: '/w',
					tags: null
				}
			} ),
			get: vi.fn(),
			add: vi.fn(),
			remove: vi.fn(),
			setCurrent: vi.fn(),
			getUploadDirs: vi.fn().mockReturnValue( [ '/home/user/uploads' ] )
		}
	};
} );

vi.mock( '../../src/common/wikiDiscovery.js', () => ( {
	discoverWiki: vi.fn()
} ) );

vi.mock( '../../src/common/uploadGuard.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/uploadGuard.js' )>(
		'../../src/common/uploadGuard.js'
	);
	return {
		...actual,
		assertAllowedPath: vi.fn()
	};
} );

vi.mock( '../../src/common/fileExistence.js', async () => {
	const actual = await vi.importActual<typeof import( '../../src/common/fileExistence.js' )>(
		'../../src/common/fileExistence.js'
	);
	return {
		...actual,
		assertFileExists: vi.fn()
	};
} );

vi.mock( '../../src/resources/index.js', () => ( {
	removeLicenseCache: vi.fn()
} ) );

import { getMwn } from '../../src/common/mwn.js';
import { wikiService } from '../../src/common/wikiService.js';
import { discoverWiki } from '../../src/common/wikiDiscovery.js';
import { assertAllowedPath } from '../../src/common/uploadGuard.js';
import { assertFileExists } from '../../src/common/fileExistence.js';
import { fakeContext } from '../helpers/fakeContext.js';
import { dispatch } from '../../src/runtime/dispatcher.js';

type Mwn = Awaited<ReturnType<typeof getMwn>>;

function setMwn( overrides: Parameters<typeof createMockMwn>[ 0 ] = {} ): void {
	vi.mocked( getMwn ).mockResolvedValue( createMockMwn( overrides ) as unknown as Mwn );
}

const fakeMcpServer = { sendResourceListChanged: vi.fn() } as unknown as Parameters<
	typeof import( '../../src/tools/add-wiki.js' )[ 'handleAddWikiTool' ]
>[ 0 ];

describe( 'pre-refactor MCP response snapshots', () => {
	beforeEach( () => {
		vi.clearAllMocks();
		// Reset wikiService defaults that some tests mutate.
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'test-wiki',
			config: {
				sitename: 'Test',
				server: 'https://test.wiki',
				articlepath: '/wiki',
				scriptpath: '/w',
				tags: null
			}
		} as ReturnType<typeof wikiService.getCurrent> );
		vi.mocked( wikiService.getUploadDirs ).mockReturnValue( [ '/home/user/uploads' ] );
	} );

	// ------------------------------------------------------------------
	// 1. get-page
	// ------------------------------------------------------------------

	it( 'get-page happy path', async () => {
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

		const { getPage } = await import( '../../src/tools/get-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPage, ctx )( {
			title: 'Test Page',
			content: 'source' as any,
			metadata: false
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-page error path (missingtitle)', async () => {
		const mock = createMockMwn( {
			read: vi.fn().mockRejectedValue( createMockMwnError( 'missingtitle' ) )
		} );

		const { getPage } = await import( '../../src/tools/get-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPage, ctx )( {
			title: 'Missing',
			content: 'source' as any,
			metadata: false
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 2. get-pages
	// ------------------------------------------------------------------

	it( 'get-pages happy path', async () => {
		const mock = createMockMwn( {
			massQuery: vi.fn().mockResolvedValue( [ {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Foo',
						revisions: [ {
							revid: 101,
							timestamp: '2026-01-01T00:00:00Z',
							slots: {
								main: {
									contentmodel: 'wikitext',
									content: 'Body of Foo'
								}
							}
						} ]
					} ]
				}
			} ] )
		} );

		const { getPages } = await import( '../../src/tools/get-pages.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPages, ctx )( {
			titles: [ 'Foo' ],
			content: 'source' as any,
			metadata: false,
			followRedirects: true
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-pages error path (upstream_failure)', async () => {
		const mock = createMockMwn( {
			massQuery: vi.fn().mockRejectedValue( createMockMwnError( 'internal_api_error' ) )
		} );

		const { getPages } = await import( '../../src/tools/get-pages.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPages, ctx )( {
			titles: [ 'Foo' ],
			content: 'source' as any,
			metadata: false,
			followRedirects: true
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 3. get-page-history
	// ------------------------------------------------------------------

	it( 'get-page-history happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						revisions: [ {
							revid: 100,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'edit',
							size: 500,
							minor: false
						} ]
					} ]
				}
			} )
		} );

		const { getPageHistory } = await import( '../../src/tools/get-page-history.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPageHistory, ctx )( { title: 'Test Page' } );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-page-history error path (missingtitle)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { missing: true, title: 'Nonexistent' } ] }
			} )
		} );

		const { getPageHistory } = await import( '../../src/tools/get-page-history.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getPageHistory, ctx )( { title: 'Nonexistent' } );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 4. get-recent-changes
	// ------------------------------------------------------------------

	it( 'get-recent-changes happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					recentchanges: [ {
						type: 'edit',
						title: 'Help:Foo',
						ns: 12,
						timestamp: '2026-01-01T12:34:56Z',
						user: 'Alice',
						userid: 42,
						revid: 1234567,
						old_revid: 1234500,
						newlen: 1523,
						oldlen: 1500,
						comment: 'typo fix',
						minor: false,
						bot: false,
						tags: []
					} ]
				}
			} )
		} );

		const { getRecentChanges } = await import( '../../src/tools/get-recent-changes.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getRecentChanges, ctx )( {} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-recent-changes error path (invalid_input)', async () => {
		const mock = createMockMwn();
		const { getRecentChanges } = await import( '../../src/tools/get-recent-changes.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getRecentChanges, ctx )( {
			user: 'Alice',
			excludeUser: 'Bob'
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 5. get-revision
	// ------------------------------------------------------------------

	it( 'get-revision happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						pageid: 1,
						title: 'Test Page',
						revisions: [ {
							revid: 42,
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							userid: 1,
							comment: 'edit',
							size: 500,
							minor: false,
							content: 'Hello world'
						} ]
					} ]
				}
			} )
		} );

		const { getRevision } = await import( '../../src/tools/get-revision.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getRevision, ctx )( {
			revisionId: 42,
			content: 'source' as any,
			metadata: false
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-revision error path (nosuchrevid)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: { pages: [ { pageid: 0, title: '', missing: true } ] }
			} )
		} );

		const { getRevision } = await import( '../../src/tools/get-revision.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getRevision, ctx )( {
			revisionId: 99999,
			content: 'source' as any,
			metadata: false
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 6. get-file
	// ------------------------------------------------------------------

	it( 'get-file happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ {
						title: 'File:Example.png',
						imageinfo: [ {
							url: 'https://test.wiki/images/example.png',
							descriptionurl: 'https://test.wiki/wiki/File:Example.png',
							size: 12345,
							width: 800,
							height: 600,
							mime: 'image/png',
							timestamp: '2026-01-01T00:00:00Z',
							user: 'Admin',
							thumburl: 'https://test.wiki/images/thumb/example.png/200px-example.png'
						} ]
					} ]
				}
			} )
		} );

		const { getFile } = await import( '../../src/tools/get-file.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getFile, ctx )( { title: 'Example.png' } );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-file error path (missingtitle)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					pages: [ { title: 'File:Missing.png', missing: true } ]
				}
			} )
		} );

		const { getFile } = await import( '../../src/tools/get-file.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getFile, ctx )( { title: 'Missing.png' } );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 7. get-category-members
	// ------------------------------------------------------------------

	it( 'get-category-members happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					categorymembers: [
						{ pageid: 1, ns: 0, title: 'Alpha', type: 'page' },
						{ pageid: 2, ns: 6, title: 'File:Bar.png', type: 'file' }
					]
				}
			} )
		} );

		const { getCategoryMembers } = await import( '../../src/tools/get-category-members.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getCategoryMembers, ctx )( { category: 'Foo' } );
		expect( result ).toMatchSnapshot();
	} );

	it( 'get-category-members error path (upstream_failure)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( createMockMwnError( 'internal_api_error' ) )
		} );

		const { getCategoryMembers } = await import( '../../src/tools/get-category-members.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( getCategoryMembers, ctx )( { category: 'Foo' } );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 8. search-page
	// ------------------------------------------------------------------

	it( 'search-page happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					search: [ {
						ns: 0,
						title: 'Test Page',
						pageid: 1,
						size: 1234,
						snippet: 'matching <span class="searchmatch">text</span>',
						timestamp: '2026-01-01T00:00:00Z',
						wordcount: 80
					} ]
				}
			} )
		} );

		const { searchPage } = await import( '../../src/tools/search-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( searchPage, ctx )( { query: 'test query', limit: 10 } );
		expect( result ).toMatchSnapshot();
	} );

	it( 'search-page error path (upstream_failure)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( createMockMwnError( 'srbackenderror' ) )
		} );

		const { searchPage } = await import( '../../src/tools/search-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( searchPage, ctx )( { query: 'test', limit: 10 } );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 9. search-page-by-prefix
	// ------------------------------------------------------------------

	it( 'search-page-by-prefix happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				query: {
					allpages: [
						{ pageid: 1, ns: 0, title: 'Alpha' },
						{ pageid: 2, ns: 0, title: 'Alphabet' }
					]
				}
			} )
		} );

		const { searchPageByPrefix } = await import( '../../src/tools/search-page-by-prefix.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( searchPageByPrefix, ctx )( {
			prefix: 'Alph',
			limit: 50,
			namespace: 0
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'search-page-by-prefix error path (upstream_failure)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( createMockMwnError( 'invalidprefix' ) )
		} );

		const { searchPageByPrefix } = await import( '../../src/tools/search-page-by-prefix.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( searchPageByPrefix, ctx )( {
			prefix: '!',
			limit: 10,
			namespace: 0
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 10. parse-wikitext
	// ------------------------------------------------------------------

	it( 'parse-wikitext happy path', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				parse: { text: '<p>Hello</p>', parsewarnings: [] }
			} )
		} );

		const { parseWikitext } = await import( '../../src/tools/parse-wikitext.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( parseWikitext, ctx )( {
			wikitext: "'''Hello'''",
			applyPreSaveTransform: true
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'parse-wikitext error path (upstream_failure)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue( createMockMwnError( 'parsererror' ) )
		} );

		const { parseWikitext } = await import( '../../src/tools/parse-wikitext.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( parseWikitext, ctx )( {
			wikitext: 'x',
			applyPreSaveTransform: true
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 11. compare-pages
	// ------------------------------------------------------------------

	it( 'compare-pages happy path', async () => {
		const PAIRED_CHANGE_HTML = [
			'<table class="diff">',
			'<tr><td colspan="2" class="diff-lineno">Line 1:</td><td colspan="2" class="diff-lineno">Line 1:</td></tr>',
			'<tr><td class="diff-marker">-</td><td class="diff-deletedline"><div>old</div></td>',
			'<td class="diff-marker">+</td><td class="diff-addedline"><div>new</div></td></tr>',
			'</table>'
		].join( '' );

		const mock = createMockMwn( {
			request: vi.fn().mockResolvedValue( {
				compare: {
					fromrevid: 42,
					fromtitle: 'Foo',
					fromsize: 100,
					fromtimestamp: '2026-01-01T00:00:00Z',
					torevid: 57,
					totitle: 'Foo',
					tosize: 105,
					totimestamp: '2026-01-02T00:00:00Z',
					body: PAIRED_CHANGE_HTML
				}
			} )
		} );

		const { comparePages } = await import( '../../src/tools/compare-pages.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( comparePages, ctx )( {
			fromRevision: 42,
			toRevision: 57
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'compare-pages error path (nosuchrevid)', async () => {
		const mock = createMockMwn( {
			request: vi.fn().mockRejectedValue(
				new Error( 'nosuchrevid: There is no revision with ID 99999.' )
			)
		} );

		const { comparePages } = await import( '../../src/tools/compare-pages.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( comparePages, ctx )( {
			fromRevision: 99999,
			toRevision: 57
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 12. create-page
	// ------------------------------------------------------------------

	it( 'create-page happy path', async () => {
		setMwn( {
			create: vi.fn().mockResolvedValue( {
				result: 'Success',
				pageid: 10,
				title: 'New Page',
				contentmodel: 'wikitext',
				oldrevid: 0,
				newrevid: 1,
				newtimestamp: '2026-01-01T00:00:00Z'
			} )
		} );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		const result = await handleCreatePageTool( 'Hello', 'New Page', 'test', 'wikitext' );
		expect( result ).toMatchSnapshot();
	} );

	it( 'create-page error path (articleexists)', async () => {
		setMwn( {
			create: vi.fn().mockRejectedValue( createMockMwnError( 'articleexists' ) )
		} );

		const { handleCreatePageTool } = await import( '../../src/tools/create-page.js' );
		const result = await handleCreatePageTool( 'Hello', 'Existing Page', 'comment', 'wikitext' );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 13. update-page
	// ------------------------------------------------------------------

	it( 'update-page happy path', async () => {
		setMwn( {
			request: vi.fn().mockResolvedValue( {
				edit: {
					result: 'Success',
					pageid: 5,
					title: 'My Page',
					contentmodel: 'wikitext',
					oldrevid: 41,
					newrevid: 42,
					newtimestamp: '2026-01-02T00:00:00Z'
				}
			} ),
			getCsrfToken: vi.fn().mockResolvedValue( 'csrf-token' )
		} );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( {
			title: 'My Page',
			source: 'Updated content',
			latestId: 41,
			comment: 'edit summary'
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'update-page error path (missingtitle)', async () => {
		setMwn( {
			request: vi.fn().mockRejectedValue( createMockMwnError( 'missingtitle' ) ),
			getCsrfToken: vi.fn().mockResolvedValue( 'csrf-token' )
		} );

		const { handleUpdatePageTool } = await import( '../../src/tools/update-page.js' );
		const result = await handleUpdatePageTool( {
			title: 'Does Not Exist',
			source: 'content',
			latestId: 1
		} );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 14. delete-page
	// ------------------------------------------------------------------

	it( 'delete-page happy path', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockResolvedValue( {
				title: 'Old Page',
				reason: 'spam',
				logid: 42
			} )
		} );

		const { deletePage } = await import( '../../src/tools/delete-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( deletePage, ctx )( {
			title: 'Old Page',
			comment: 'spam'
		} );
		expect( result ).toMatchSnapshot();
	} );

	it( 'delete-page error path (missingtitle)', async () => {
		const mock = createMockMwn( {
			delete: vi.fn().mockRejectedValue( createMockMwnError( 'missingtitle' ) )
		} );

		const { deletePage } = await import( '../../src/tools/delete-page.js' );
		const ctx = fakeContext( { mwn: async () => mock as never } );
		const result = await dispatch( deletePage, ctx )( { title: 'Nonexistent' } );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 15. undelete-page
	// ------------------------------------------------------------------

	it( 'undelete-page happy path', async () => {
		setMwn( {
			undelete: vi.fn().mockResolvedValue( {
				title: 'Restored Page',
				reason: 'oops',
				revisions: 12
			} )
		} );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Restored Page', 'oops' );
		expect( result ).toMatchSnapshot();
	} );

	it( 'undelete-page error path (permissiondenied)', async () => {
		setMwn( {
			undelete: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );

		const { handleUndeletePageTool } = await import( '../../src/tools/undelete-page.js' );
		const result = await handleUndeletePageTool( 'Protected' );
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 16. upload-file
	// ------------------------------------------------------------------

	it( 'upload-file happy path', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/cat.jpg' );
		setMwn( {
			upload: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );

		const { handleUploadFileTool } = await import( '../../src/tools/upload-file.js' );
		const result = await handleUploadFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'upload-file error path (permissiondenied)', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/cat.jpg' );
		setMwn( {
			upload: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );

		const { handleUploadFileTool } = await import( '../../src/tools/upload-file.js' );
		const result = await handleUploadFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 17. upload-file-from-url
	// ------------------------------------------------------------------

	it( 'upload-file-from-url happy path', async () => {
		setMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );

		const { handleUploadFileFromUrlTool } = await import( '../../src/tools/upload-file-from-url.js' );
		const result = await handleUploadFileFromUrlTool(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'upload-file-from-url error path (permissiondenied)', async () => {
		setMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );

		const { handleUploadFileFromUrlTool } = await import( '../../src/tools/upload-file-from-url.js' );
		const result = await handleUploadFileFromUrlTool(
			'https://source.example/cat.jpg',
			'File:Cat.jpg',
			'A cat.'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 18. update-file
	// ------------------------------------------------------------------

	it( 'update-file happy path', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		setMwn( {
			upload: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg',
			'New colour pass'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'update-file error path (permissiondenied)', async () => {
		vi.mocked( assertAllowedPath ).mockResolvedValue( '/home/user/uploads/cat.jpg' );
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		setMwn( {
			upload: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );

		const { handleUpdateFileTool } = await import( '../../src/tools/update-file.js' );
		const result = await handleUpdateFileTool(
			'/home/user/uploads/cat.jpg',
			'File:Cat.jpg'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 19. update-file-from-url
	// ------------------------------------------------------------------

	it( 'update-file-from-url happy path', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		setMwn( {
			uploadFromUrl: vi.fn().mockResolvedValue( {
				result: 'Success',
				filename: 'Cat.jpg',
				imageinfo: {
					descriptionurl: 'https://test.wiki/wiki/File:Cat.jpg',
					url: 'https://test.wiki/images/Cat.jpg'
				}
			} )
		} );

		const { handleUpdateFileFromUrlTool } = await import( '../../src/tools/update-file-from-url.js' );
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg',
			'Higher resolution'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'update-file-from-url error path (permissiondenied)', async () => {
		vi.mocked( assertFileExists ).mockResolvedValue( undefined );
		setMwn( {
			uploadFromUrl: vi.fn().mockRejectedValue( createMockMwnError( 'permissiondenied' ) )
		} );

		const { handleUpdateFileFromUrlTool } = await import( '../../src/tools/update-file-from-url.js' );
		const result = await handleUpdateFileFromUrlTool(
			'https://example.com/cat.jpg',
			'File:Cat.jpg'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 20. add-wiki
	// ------------------------------------------------------------------

	it( 'add-wiki happy path', async () => {
		vi.mocked( discoverWiki ).mockResolvedValue( {
			servername: 'example.org',
			sitename: 'Example Wiki',
			server: 'https://example.org',
			articlepath: '/wiki',
			scriptpath: '/w'
		} );
		vi.mocked( wikiService.add ).mockImplementation( () => {} );

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const reconcile = vi.fn();
		const result = await handleAddWikiTool(
			fakeMcpServer,
			reconcile,
			'https://example.org/'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'add-wiki error path (upstream_failure)', async () => {
		vi.mocked( discoverWiki ).mockRejectedValue( new Error( 'Connection refused' ) );

		const { handleAddWikiTool } = await import( '../../src/tools/add-wiki.js' );
		const reconcile = vi.fn();
		const result = await handleAddWikiTool(
			fakeMcpServer,
			reconcile,
			'https://example.org/'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 21. remove-wiki
	// ------------------------------------------------------------------

	it( 'remove-wiki happy path', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( {
			sitename: 'Example',
			server: 'https://example.org'
		} as ReturnType<typeof wikiService.get> );
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'other.example.org',
			config: {} as ReturnType<typeof wikiService.getCurrent>[ 'config' ]
		} );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool(
			fakeMcpServer,
			reconcile,
			'mcp://wikis/example.org'
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'remove-wiki error path (invalid_input)', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( undefined );

		const { handleRemoveWikiTool } = await import( '../../src/tools/remove-wiki.js' );
		const reconcile = vi.fn();
		const result = await handleRemoveWikiTool(
			fakeMcpServer,
			reconcile,
			'mcp://wikis/unknown.example.org'
		);
		expect( result ).toMatchSnapshot();
	} );

	// ------------------------------------------------------------------
	// 22. set-wiki
	// ------------------------------------------------------------------

	it( 'set-wiki happy path', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( {
			sitename: 'Example',
			server: 'https://example.org'
		} as ReturnType<typeof wikiService.get> );
		vi.mocked( wikiService.getCurrent ).mockReturnValue( {
			key: 'example.org',
			config: {
				sitename: 'Example',
				server: 'https://example.org'
			} as ReturnType<typeof wikiService.getCurrent>[ 'config' ]
		} );

		const { handleSetWikiTool } = await import( '../../src/tools/set-wiki.js' );
		const onActiveWikiChanged = vi.fn();
		const result = await handleSetWikiTool(
			'mcp://wikis/example.org',
			onActiveWikiChanged
		);
		expect( result ).toMatchSnapshot();
	} );

	it( 'set-wiki error path (invalid_input)', async () => {
		vi.mocked( wikiService.get ).mockReturnValue( undefined );

		const { handleSetWikiTool } = await import( '../../src/tools/set-wiki.js' );
		const onActiveWikiChanged = vi.fn();
		const result = await handleSetWikiTool(
			'mcp://wikis/unknown.example.org',
			onActiveWikiChanged
		);
		expect( result ).toMatchSnapshot();
	} );
} );
