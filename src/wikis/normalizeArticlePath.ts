// MediaWiki's siteinfo.general.articlepath carries a '$1' for the title. A
// trailing '/$1' is dropped, so the path reads as the configured '/wiki' does;
// one anywhere else, as in '/index.php?title=$1', stays for buildPageUrl to
// substitute.
export function normalizeArticlePath(articlepath: string): string {
	return articlepath.replace(/\/\$1$/, '');
}
