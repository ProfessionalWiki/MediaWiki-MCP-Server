// An article path is kept as '/wiki', the form the configuration uses, or as
// MediaWiki's own pattern when its '$1' does not end it, as in
// '/index.php?title=$1'.

export function normalizeArticlePath(articlepath: string): string {
	return articlepath.replace(/\/\$1$/, '');
}

export function articlePathPattern(articlepath: string): string {
	return articlepath.includes('$1') ? articlepath : `${articlepath}/$1`;
}
