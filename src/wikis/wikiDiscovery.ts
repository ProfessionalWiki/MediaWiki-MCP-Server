import { errorMessage } from '../errors/isErrnoException.ts';
import { WikiTimeoutError } from '../errors/wikiTimeoutError.ts';
import type { CallDeadline } from '../runtime/callDeadline.ts';
import { makeApiRequest, fetchPageHtml } from '../transport/httpFetch.ts';
import { assertPublicDestination } from '../transport/ssrfGuard.ts';
import { logger } from '../runtime/logger.ts';
import { normalizeServer } from './normalizeServer.ts';

const COMMON_SCRIPT_PATHS = ['/w', ''];

/** Whether a rejection is the budget expiring rather than the host answering. */
function isAborted(error: unknown): boolean {
	return error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError');
}

interface MediaWikiActionApiSiteInfoGeneral {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
}

interface MediaWikiActionApiSiteInfoQuery {
	general: MediaWikiActionApiSiteInfoGeneral;
}

interface MediaWikiActionApiResponse {
	query?: MediaWikiActionApiSiteInfoQuery;
}

export interface WikiInfo {
	sitename: string;
	articlepath: string;
	scriptpath: string;
	server: string;
	servername: string;
}

async function fetchWikiInfoFromApi(
	wikiServer: string,
	scriptPath: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	const baseUrl = `${wikiServer}${scriptPath}/api.php`;
	const params = {
		action: 'query',
		meta: 'siteinfo',
		siprop: 'general',
		format: 'json',
		origin: '*',
	};

	let data: MediaWikiActionApiResponse | null = null;
	try {
		data = await makeApiRequest<MediaWikiActionApiResponse>(baseUrl, params, {
			signal: deadline.signal,
		});
	} catch (error) {
		// A path that is simply wrong answers 404, and discovery moves on to the
		// next candidate. Running out of time is not a wrong path, and reporting
		// it as one sends the caller after a URL typo that is not there.
		if (isAborted(error)) {
			throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
		}
		logger.error('Error fetching wiki info', {
			baseUrl,
			error: errorMessage(error),
		});
		return null;
	}

	if (data === null || data.query?.general === undefined) {
		return null;
	}

	const general = data.query.general;

	if (typeof general.scriptpath !== 'string') {
		return null;
	}

	return {
		sitename: general.sitename,
		scriptpath: general.scriptpath,
		articlepath: general.articlepath.replace('/$1', ''),
		server: normalizeServer(general.server),
		servername: general.servername,
	};
}

async function fetchUsingCommonScriptPaths(
	wikiServer: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	for (const candidatePath of COMMON_SCRIPT_PATHS) {
		const apiResult = await fetchWikiInfoFromApi(wikiServer, candidatePath, deadline);
		if (apiResult) {
			return apiResult;
		}
	}
	return null;
}

function extractScriptPathFromSearchForm(htmlContent: string, wikiServer: string): string | null {
	const searchFormMatch = htmlContent.match(
		/<form[^>]+id=['"]searchform['"][^>]+action=['"]([^'"]*index\.php[^'"]*)['"]/i,
	);
	if (searchFormMatch && searchFormMatch[1]) {
		const actionAttribute = searchFormMatch[1];
		try {
			const fullActionUrl = new URL(actionAttribute, wikiServer);
			const path = fullActionUrl.pathname;
			const indexPathIndex = path.toLowerCase().lastIndexOf('/index.php');
			if (indexPathIndex !== -1) {
				return path.slice(0, indexPathIndex);
			}
		} catch (error) {
			logger.warning('Error extracting script path from search form', {
				error: errorMessage(error),
			});
		}
	}
	return null;
}

function extractScriptPathsFromHtml(htmlContent: string | null, wikiServer: string): string[] {
	const candidatesFromHtml: string[] = [];
	if (htmlContent) {
		const fromSearchForm = extractScriptPathFromSearchForm(htmlContent, wikiServer);
		if (fromSearchForm !== null) {
			candidatesFromHtml.push(fromSearchForm);
		}
	}

	const uniqueCandidatesFromHtml = [...new Set(candidatesFromHtml)];
	return uniqueCandidatesFromHtml.filter(
		(p) => typeof p === 'string' && (p === '' || p.trim() !== ''),
	);
}

async function fetchUsingScriptPathsFromHtml(
	wikiServer: string,
	originalWikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	const htmlContent = await fetchPageHtml(originalWikiUrl, { signal: deadline.signal });
	// `fetchPageHtml` reports every failure as no content, an abort included, so
	// the budget is checked here rather than left to resurface on the next
	// request — which it would not do if that request failed for its own reason.
	if (deadline.signal.aborted) {
		throw new WikiTimeoutError(deadline.timeoutMs, deadline.phase);
	}
	const htmlScriptPathCandidates = extractScriptPathsFromHtml(htmlContent, wikiServer);
	const pathsToTry =
		htmlScriptPathCandidates.length > 0 ? htmlScriptPathCandidates : COMMON_SCRIPT_PATHS;

	for (const candidatePath of pathsToTry) {
		const apiResult = await fetchWikiInfoFromApi(wikiServer, candidatePath, deadline);
		if (apiResult) {
			return apiResult;
		}
	}

	return null;
}

async function getWikiInfo(
	wikiServer: string,
	originalWikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	return (
		(await fetchUsingCommonScriptPaths(wikiServer, deadline)) ??
		(await fetchUsingScriptPathsFromHtml(wikiServer, originalWikiUrl, deadline))
	);
}

function parseWikiUrl(wikiUrl: string): string {
	const url = new URL(wikiUrl);
	return `${url.protocol}//${url.host}`;
}

/**
 * `deadline` covers all of discovery rather than one request, which would
 * multiply across the five it can make. `fetchCore` applies no timeout of its
 * own and the URL comes from the caller, so without one a host that accepts the
 * connection and then goes quiet holds the call open until the OS gives up. The
 * DNS lookups inside `assertPublicDestination` take no signal, so they run down
 * the budget without being cancelled by it.
 */
export async function discoverWiki(
	wikiUrl: string,
	deadline: CallDeadline,
): Promise<WikiInfo | null> {
	await assertPublicDestination(wikiUrl);
	const wikiServer = parseWikiUrl(wikiUrl);
	const info = await getWikiInfo(wikiServer, wikiUrl, deadline);
	if (info !== null) {
		await assertPublicDestination(info.server);
	}
	return info;
}
