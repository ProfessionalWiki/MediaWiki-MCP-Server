export interface ApiRevisionLike {
	revid?: number;
	timestamp?: string;
	contentmodel?: string;
	size?: number;
	content?: string;
	slots?: { main?: { contentmodel?: string; content?: string; size?: number } };
}

export type NormalisedRevision = Omit<ApiRevisionLike, 'slots'> & {
	contentmodel?: string;
	content?: string;
	size?: number;
};

export interface RevisionNormalizer {
	normalise( rev: ApiRevisionLike ): NormalisedRevision;
}
