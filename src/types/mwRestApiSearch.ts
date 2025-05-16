export interface MwRestApiSearchResultThumbnail {
	mimetype: string;
	size?: number | null;
	width?: number | null;
	height?: number | null;
	duration?: number | null;
	url?: string;
}

export interface MwRestApiSearchResult {
	id: number;
	key: string;
	title: string;
	excerpt: string;
	matched_title?: string | null;
	description: string | null;
	thumbnail?: MwRestApiSearchResultThumbnail | null;
}

export interface MwRestApiSearchPageResponse {
	pages: MwRestApiSearchResult[];
}
