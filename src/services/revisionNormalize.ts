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

export class RevisionNormalizer {
	public normalise(rev: ApiRevisionLike): NormalisedRevision {
		const { slots, ...base } = rev;
		if (slots?.main) {
			return { ...base, ...slots.main };
		}
		return base;
	}
}
