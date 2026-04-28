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

export class RevisionNormalizerImpl implements RevisionNormalizer {
	public normalise( rev: ApiRevisionLike ): NormalisedRevision {
		const { slots, ...base } = rev;
		if ( slots?.main ) {
			return { ...base, ...slots.main };
		}
		return base;
	}
}
