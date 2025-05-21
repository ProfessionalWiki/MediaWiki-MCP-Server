// https://www.mediawiki.org/wiki/API:REST_API/Reference#Search_result_object
export interface MwRestApiSearchResultObject {
	id: number;
	key: string;
	title: string;
	excerpt: string;
	matched_title?: string | null;
	description: string | null;
	thumbnail?: {
		mimetype: string;
		size?: number | null;
		width?: number | null;
		height?: number | null;
		duration?: number | null;
		url?: string;
	};
}

// https://www.mediawiki.org/wiki/API:REST_API/Reference#Page_object
export interface MwRestApiPageObject {
	id: number;
	key: string;
	title: string;
	latest: {
		id: number;
		timestamp: string;
	};
	content_model: string;
	license: {
		url: string;
		title: string;
	};
	html_url?: string;
	html?: string;
	source?: string;
}

export interface MwRestApiSearchPageResponse {
	pages: MwRestApiSearchResultObject[];
}

export interface MwRestApiGetPageResponse extends Omit<MwRestApiPageObject, 'html' | 'source'> {
	html_url: string;
}
