// MediaWiki's Extension:OAuth exposes its OAuth2 endpoints under
// `<base><scriptpath>/rest.php/oauth2/...`. These helpers are the single source of
// truth for those paths so the proxy (internalBase / authorizeBase) and the
// client-side discovery fallback (wiki.server) build identical URLs. `base` and
// `scriptpath` are caller-supplied because they differ per call site.

export function mwOauth2TokenEndpoint(base: string, scriptpath: string): string {
	return `${base}${scriptpath}/rest.php/oauth2/access_token`;
}

export function mwOauth2AuthorizeEndpoint(base: string, scriptpath: string): string {
	return `${base}${scriptpath}/rest.php/oauth2/authorize`;
}

export function mwOauth2ProfileEndpoint(base: string, scriptpath: string): string {
	return `${base}${scriptpath}/rest.php/oauth2/resource/profile`;
}
