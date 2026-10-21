// MediaWiki's siteinfo.general.server may be protocol-relative ("//host");
// normalize to https, matching the convention in src/transport/ssrfGuard.ts.
export function normalizeServer(server: string): string {
	return server.startsWith('//') ? 'https:' + server : server;
}
