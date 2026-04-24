import { describe, it, expect } from 'vitest';
import {
	PageMetadataSchema,
	RevisionSummarySchema,
	SearchResultSchema,
	CategoryMemberSchema,
	TruncationSchema,
	ErrorEnvelopeSchema
} from '../../src/common/schemas.js';

describe( 'PageMetadataSchema', () => {
	it( 'accepts a full page metadata shape', () => {
		const parsed = PageMetadataSchema.parse( {
			pageId: 42,
			title: 'Example',
			latestRevisionId: 17,
			latestRevisionTimestamp: '2026-04-24T10:00:00Z',
			contentModel: 'wikitext',
			size: 1234,
			url: 'https://example.org/wiki/Example'
		} );
		expect( parsed.title ).toBe( 'Example' );
	} );

	it( 'rejects a payload missing pageId', () => {
		expect( () => PageMetadataSchema.parse( {
			title: 'Example',
			latestRevisionId: 17,
			latestRevisionTimestamp: 't',
			contentModel: 'wikitext',
			size: 0,
			url: 'u'
		} ) ).toThrow();
	} );
} );

describe( 'RevisionSummarySchema', () => {
	it( 'accepts a page-history row', () => {
		RevisionSummarySchema.parse( {
			revisionId: 17,
			timestamp: '2026-04-24T10:00:00Z',
			user: 'Alice',
			userid: 3,
			comment: 'tweak',
			size: 1024,
			minor: false
		} );
	} );

	it( 'accepts an optional tags array', () => {
		RevisionSummarySchema.parse( {
			revisionId: 18, timestamp: 't', user: 'u', userid: 1,
			comment: 'c', size: 0, minor: true, tags: [ 'rollback' ]
		} );
	} );
} );

describe( 'SearchResultSchema', () => {
	it( 'accepts a full-text result', () => {
		SearchResultSchema.parse( {
			title: 'Foo',
			pageId: 1,
			snippet: '...foo...',
			size: 500,
			wordCount: 80,
			timestamp: 't'
		} );
	} );

	it( 'accepts a prefix-only result (title + pageId)', () => {
		SearchResultSchema.parse( { title: 'Foo', pageId: 1 } );
	} );
} );

describe( 'CategoryMemberSchema', () => {
	it( 'accepts a category member', () => {
		CategoryMemberSchema.parse( { title: 'Foo', pageId: 1, namespace: 0 } );
	} );
	it( 'accepts an optional type discriminator', () => {
		CategoryMemberSchema.parse( { title: 'Foo', pageId: 1, namespace: 0, type: 'subcat' } );
	} );
} );

describe( 'TruncationSchema', () => {
	it( 'accepts more-available variant', () => {
		TruncationSchema.parse( {
			reason: 'more-available',
			returnedCount: 20,
			itemNoun: 'revisions',
			toolName: 'get-page-history',
			continueWith: { param: 'olderThan', value: 12345 }
		} );
	} );
	it( 'accepts capped-no-continuation variant', () => {
		TruncationSchema.parse( {
			reason: 'capped-no-continuation',
			returnedCount: 100,
			limit: 100,
			itemNoun: 'matches',
			narrowHint: 'narrow the query or raise limit (max 100)'
		} );
	} );
	it( 'accepts content-truncated variant', () => {
		TruncationSchema.parse( {
			reason: 'content-truncated',
			returnedBytes: 50000,
			totalBytes: 120000,
			itemNoun: 'wikitext',
			toolName: 'get-page',
			sections: [ '', 'History', 'References' ],
			remedyHint: 'To read a specific section, call get-page again with section=N.'
		} );
	} );
	it( 'rejects an unknown reason', () => {
		expect( () => TruncationSchema.parse( { reason: 'mystery' } ) ).toThrow();
	} );
} );

describe( 'ErrorEnvelopeSchema', () => {
	it( 'accepts an envelope without code', () => {
		ErrorEnvelopeSchema.parse( { category: 'not_found', message: 'Page "X" not found' } );
	} );
	it( 'accepts an envelope with code', () => {
		ErrorEnvelopeSchema.parse( {
			category: 'conflict', message: 'edit conflict', code: 'editconflict'
		} );
	} );
	it( 'rejects an invalid category', () => {
		expect( () => ErrorEnvelopeSchema.parse( {
			category: 'boom', message: 'x'
		} ) ).toThrow();
	} );
} );
