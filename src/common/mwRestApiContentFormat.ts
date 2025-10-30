export enum ContentFormat {
	source = 'source',
	html = 'html',
	none = 'none'
}

export function getSubEndpoint( content: ContentFormat ): string {
	switch ( content ) {
		case ContentFormat.none:
			return '/bare';
		case ContentFormat.source:
			return '';
		case ContentFormat.html:
			return '/with_html';
	}
}
