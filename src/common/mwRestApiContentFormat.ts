export enum ContentFormat {
	source = 'source',
	html = 'html',
	metadata = 'metadata',
	sourceAndMetadata = 'sourceAndMetadata',
	htmlAndMetadata = 'htmlAndMetadata'
}

export function getSubEndpoint( content: ContentFormat ): string {
	switch ( content ) {
		case ContentFormat.metadata:
			return '/bare';
		case ContentFormat.sourceAndMetadata:
		case ContentFormat.source:
			return '';
		case ContentFormat.htmlAndMetadata:
		case ContentFormat.html:
			return '/with_html';
	}
}
