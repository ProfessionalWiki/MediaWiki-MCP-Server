import { z } from 'zod';

export const PageMetadataSchema = z.object( {
	pageId: z.number().int().nonnegative(),
	title: z.string(),
	latestRevisionId: z.number().int().nonnegative().optional(),
	latestRevisionTimestamp: z.string().optional(),
	contentModel: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	url: z.string()
} );
export type PageMetadata = z.infer<typeof PageMetadataSchema>;

export const RevisionSummarySchema = z.object( {
	revisionId: z.number().int().nonnegative(),
	timestamp: z.string(),
	user: z.string().optional(),
	userid: z.number().int().nonnegative().optional(),
	comment: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	minor: z.boolean().optional(),
	tags: z.array( z.string() ).optional()
} );
export type RevisionSummary = z.infer<typeof RevisionSummarySchema>;

export const SearchResultSchema = z.object( {
	title: z.string(),
	pageId: z.number().int().nonnegative(),
	snippet: z.string().optional(),
	size: z.number().int().nonnegative().optional(),
	wordCount: z.number().int().nonnegative().optional(),
	timestamp: z.string().optional(),
	url: z.string().optional()
} );
export type SearchResult = z.infer<typeof SearchResultSchema>;

export const CategoryMemberSchema = z.object( {
	title: z.string(),
	pageId: z.number().int().nonnegative(),
	namespace: z.number().int().nonnegative(),
	type: z.enum( [ 'page', 'file', 'subcat' ] ).optional()
} );
export type CategoryMember = z.infer<typeof CategoryMemberSchema>;

export const TruncationSchema = z.discriminatedUnion( 'reason', [
	z.object( {
		reason: z.literal( 'more-available' ),
		returnedCount: z.number().int().nonnegative(),
		itemNoun: z.string(),
		toolName: z.string(),
		continueWith: z.object( {
			param: z.string(),
			// eslint-disable-next-line es-x/no-set-prototype-union -- z.union, not Set.prototype.union
			value: z.union( [ z.string(), z.number() ] )
		} )
	} ),
	z.object( {
		reason: z.literal( 'capped-no-continuation' ),
		returnedCount: z.number().int().nonnegative(),
		limit: z.number().int().positive(),
		itemNoun: z.string(),
		narrowHint: z.string()
	} ),
	z.object( {
		reason: z.literal( 'content-truncated' ),
		returnedBytes: z.number().int().nonnegative(),
		totalBytes: z.number().int().nonnegative(),
		itemNoun: z.string(),
		toolName: z.string(),
		sections: z.array( z.string() ).optional(),
		remedyHint: z.string()
	} )
] );
export type Truncation = z.infer<typeof TruncationSchema>;

export const ErrorEnvelopeSchema = z.object( {
	category: z.enum( [
		'not_found', 'permission_denied', 'invalid_input',
		'conflict', 'authentication', 'rate_limited', 'upstream_failure'
	] ),
	message: z.string(),
	code: z.string().optional()
} );
export type ErrorEnvelope = z.infer<typeof ErrorEnvelopeSchema>;
