import { getMwn } from './mwn.js';
import { wikiService } from './wikiService.js';
import type {
	MwRestApiSearchPageResponse,
	MwRestApiPageObject,
	MwRestApiGetPageHistoryResponse,
	MwRestApiRevisionObject,
	MwRestApiFileObject
} from '../types/mwRestApi.js';

async function searchPage(
	params?: Record<string, string>
): Promise<MwRestApiSearchPageResponse> {
	const mwn = await getMwn();
	const query = params?.q ?? '';
	const limit = params?.limit ? parseInt( params.limit ) : undefined;
	const results = await mwn.search( query, limit );

	return {
		pages: results.map( ( r ) => ( {
			id: r.pageid,
			key: r.title.replace( / /g, '_' ),
			title: r.title,
			excerpt: r.snippet ?? '',
			description: r.categorysnippet || null,
			thumbnail: undefined
		} ) )
	};
}

async function getPage(
	title: string,
	subEndpoint: string
): Promise<MwRestApiPageObject> {
	const mwn = await getMwn();

	const needContent = subEndpoint !== '/bare';
	const needHtml = subEndpoint === '/with_html';

	const rvprop = [ 'ids', 'timestamp', 'size', 'contentmodel' ];
	if ( needContent ) {
		rvprop.push( 'content' );
	}

	const response = await mwn.request( {
		action: 'query',
		titles: title,
		prop: 'info|revisions',
		rvprop: rvprop.join( '|' ),
		rvslots: 'main',
		rvlimit: 1
	} );

	const pages = response.query?.pages;
	if ( !pages || pages.length === 0 || pages[ 0 ].missing ) {
		throw new Error( `Page not found: ${ title }` );
	}

	const page = pages[ 0 ];
	const revision = page.revisions?.[ 0 ];
	const wikitext = revision?.slots?.main?.content ?? revision?.content;

	const result: MwRestApiPageObject = {
		id: page.pageid,
		key: page.title.replace( / /g, '_' ),
		title: page.title,
		latest: {
			id: revision?.revid ?? 0,
			timestamp: revision?.timestamp ?? ''
		},
		// eslint-disable-next-line camelcase
		content_model: revision?.slots?.main?.contentmodel ?? 'wikitext',
		license: { url: '', title: '' }
	};

	if ( needContent && !needHtml ) {
		result.source = wikitext ?? '';
	} else if ( needHtml ) {
		result.source = wikitext ?? '';
		result.html = await mwn.parseTitle( title );
	}

	return result;
}

async function getPageHistory(
	title: string,
	params?: Record<string, string>
): Promise<MwRestApiGetPageHistoryResponse> {
	const mwn = await getMwn();

	const apiParams: Record<string, string | number | boolean> = {
		action: 'query',
		titles: title,
		prop: 'revisions',
		rvprop: 'ids|timestamp|user|userid|comment|size',
		rvlimit: 20
	};

	if ( params?.olderThan ) {
		apiParams.rvendid = params.olderThan;
	}
	if ( params?.newerThan ) {
		apiParams.rvstartid = params.newerThan;
		apiParams.rvdir = 'newer';
	}
	if ( params?.filter ) {
		apiParams.rvtag = params.filter;
	}

	const response = await mwn.request( apiParams );
	const pages = response.query?.pages;
	if ( !pages || pages.length === 0 ) {
		return { latest: '', revisions: [] };
	}

	const page = pages[ 0 ];
	const revisions = ( page.revisions ?? [] ).map(
		( rev: Record<string, unknown>, index: number, arr: Record<string, unknown>[] ) => {
			const prevSize = arr[ index + 1 ] ?
				( arr[ index + 1 ] as Record<string, unknown> ).size as number :
				( rev.size as number );
			return {
				id: rev.revid as number,
				page: { id: page.pageid as number, title: page.title as string },
				user: { id: rev.userid as number, name: rev.user as string },
				timestamp: rev.timestamp as string,
				comment: ( rev.comment as string ) ?? '',
				size: rev.size as number,
				delta: ( rev.size as number ) - prevSize,
				minor: !!rev.minor
			} as MwRestApiRevisionObject;
		}
	);

	return { latest: '', revisions };
}

async function getRevision(
	revisionId: number,
	subEndpoint: string
): Promise<MwRestApiRevisionObject> {
	const mwn = await getMwn();

	const needContent = subEndpoint !== '/bare';
	const needHtml = subEndpoint === '/with_html';

	const rvprop = [ 'ids', 'timestamp', 'user', 'userid', 'comment', 'size' ];
	if ( needContent ) {
		rvprop.push( 'content' );
	}

	const response = await mwn.request( {
		action: 'query',
		revids: revisionId,
		prop: 'revisions',
		rvprop: rvprop.join( '|' ),
		rvslots: 'main'
	} );

	const pages = response.query?.pages;
	if ( !pages || pages.length === 0 ) {
		throw new Error( `Revision not found: ${ revisionId }` );
	}

	const page = pages[ 0 ];
	const rev = page.revisions?.[ 0 ];
	if ( !rev ) {
		throw new Error( `Revision not found: ${ revisionId }` );
	}

	const wikitext = rev.slots?.main?.content ?? rev.content;

	const result: MwRestApiRevisionObject = {
		id: rev.revid ?? revisionId,
		page: { id: page.pageid, title: page.title },
		user: { id: rev.userid ?? 0, name: rev.user ?? '' },
		timestamp: rev.timestamp ?? '',
		comment: rev.comment ?? '',
		size: rev.size ?? 0,
		delta: 0,
		minor: !!rev.minor
	};

	if ( needContent && !needHtml ) {
		result.source = wikitext ?? '';
	} else if ( needHtml ) {
		result.source = wikitext ?? '';
		const parsed = await mwn.request( {
			action: 'parse',
			oldid: revisionId,
			prop: 'text'
		} );
		result.html = parsed.parse?.text ?? '';
	}

	return result;
}

async function getFile(
	title: string
): Promise<MwRestApiFileObject> {
	const mwn = await getMwn();
	const fileTitle = title.startsWith( 'File:' ) ? title : `File:${ title }`;

	const response = await mwn.request( {
		action: 'query',
		titles: fileTitle,
		prop: 'imageinfo',
		iiprop: 'timestamp|user|userid|url|size|mediatype|mime',
		iiurlwidth: 200
	} );

	const pages = response.query?.pages;
	if ( !pages || pages.length === 0 || pages[ 0 ].missing || !pages[ 0 ].imageinfo?.length ) {
		throw new Error( `File not found: ${ title }` );
	}

	const page = pages[ 0 ];
	const info = page.imageinfo[ 0 ];
	const { server, articlepath } = wikiService.getCurrent().config;

	return {
		title: page.title,
		// eslint-disable-next-line camelcase
		file_description_url: `${ server }${ articlepath }/${ encodeURIComponent( page.title ) }`,
		latest: {
			timestamp: info.timestamp ?? '',
			user: { id: info.userid ?? 0, name: info.user ?? '' }
		},
		preferred: {
			mediatype: info.mediatype ?? info.mime ?? '',
			size: info.size ?? null,
			width: info.width ?? null,
			height: info.height ?? null,
			duration: null,
			url: info.url ?? ''
		},
		original: {
			mediatype: info.mediatype ?? info.mime ?? '',
			size: info.size ?? null,
			width: info.width ?? null,
			height: info.height ?? null,
			duration: null,
			url: info.url ?? ''
		},
		thumbnail: info.thumburl ? {
			mediatype: info.mediatype ?? info.mime ?? '',
			size: null,
			width: info.thumbwidth ?? null,
			height: info.thumbheight ?? null,
			duration: null,
			url: info.thumburl
		} : undefined
	};
}

async function createPage(
	body: Record<string, unknown>
): Promise<MwRestApiPageObject> {
	const mwn = await getMwn();

	const options: Record<string, string> = {};
	const contentModel = body.content_model as string | undefined;
	if ( contentModel ) {
		options.contentmodel = contentModel;
	}

	const editResponse = await mwn.create(
		body.title as string,
		body.source as string,
		body.comment as string,
		options
	);

	return {
		id: editResponse.pageid,
		key: editResponse.title.replace( / /g, '_' ),
		title: editResponse.title,
		latest: {
			id: editResponse.newrevid,
			timestamp: editResponse.newtimestamp
		},
		// eslint-disable-next-line camelcase
		content_model: editResponse.contentmodel ?? contentModel ?? 'wikitext',
		license: { url: '', title: '' }
	};
}

async function updatePage(
	title: string,
	body: Record<string, unknown>
): Promise<MwRestApiPageObject> {
	const mwn = await getMwn();

	const latest = body.latest as { id: number } | undefined;
	const options: Record<string, string | number> = {};
	if ( latest?.id ) {
		options.baserevid = latest.id;
	}

	const editResponse = await mwn.save(
		title,
		body.source as string,
		body.comment as string,
		options
	);

	return {
		id: editResponse.pageid,
		key: editResponse.title.replace( / /g, '_' ),
		title: editResponse.title,
		latest: {
			id: editResponse.newrevid,
			timestamp: editResponse.newtimestamp
		},
		// eslint-disable-next-line camelcase
		content_model: editResponse.contentmodel ?? 'wikitext',
		license: { url: '', title: '' }
	};
}

// Route a REST API call to its action API equivalent based on method + path
export async function restFallback(
	method: string,
	path: string,
	params?: Record<string, string>,
	body?: Record<string, unknown>
): Promise<unknown> {
	if ( method === 'GET' ) {
		if ( path === '/v1/search/page' ) {
			return searchPage( params );
		}

		const historyMatch = path.match( /^\/v1\/page\/(.+?)\/history$/ );
		if ( historyMatch ) {
			return getPageHistory( decodeURIComponent( historyMatch[ 1 ] ), params );
		}

		const pageMatch = path.match( /^\/v1\/page\/(.+?)(\/(bare|with_html))?$/ );
		if ( pageMatch ) {
			return getPage( decodeURIComponent( pageMatch[ 1 ] ), pageMatch[ 2 ] ?? '' );
		}

		const revisionMatch = path.match( /^\/v1\/revision\/(\d+)(\/(bare|with_html))?$/ );
		if ( revisionMatch ) {
			return getRevision( parseInt( revisionMatch[ 1 ] ), revisionMatch[ 2 ] ?? '' );
		}

		const fileMatch = path.match( /^\/v1\/file\/(.+)$/ );
		if ( fileMatch ) {
			return getFile( decodeURIComponent( fileMatch[ 1 ] ) );
		}
	}

	if ( method === 'POST' && path === '/v1/page' && body ) {
		return createPage( body );
	}

	if ( method === 'PUT' ) {
		const updateMatch = path.match( /^\/v1\/page\/(.+)$/ );
		if ( updateMatch && body ) {
			return updatePage( decodeURIComponent( updateMatch[ 1 ] ), body );
		}
	}

	throw new Error( `No action API fallback for ${ method } ${ path }` );
}
