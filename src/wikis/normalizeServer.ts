// MediaWiki's siteinfo.general.server may be protocol-relative ("//host");
// normalize to https, matching the convention in src/transport/ssrfGuard.ts.
// Shared by the authenticated siteInfo resolver and the anonymous wikiProbe.
export function normalizeServer(server: string): string {
	return server.startsWith('//') ? 'https:' + server : server;
}
