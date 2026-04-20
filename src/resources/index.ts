/* eslint-disable n/no-missing-import */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../common/constants.js';
import { getMwn } from '../common/mwn.js';

type LicenseInfo = { url: string; title: string };

const licenseCache = new Map<string, LicenseInfo>();

export function removeLicenseCache( wikiKey: string ): void {
	licenseCache.delete( wikiKey );
}

async function getLicenseInfo( wikiKey: string ): Promise<LicenseInfo | undefined> {
	const cached = licenseCache.get( wikiKey );
	if ( cached ) {
		return cached;
	}

	try {
		const mwn = await getMwn( wikiKey );
		const response = await mwn.request( {
			action: 'query',
			meta: 'siteinfo',
			siprop: 'rightsinfo',
			formatversion: '2'
		} );

		const rightsInfo = response.query?.rightsinfo;
		if ( rightsInfo?.url && rightsInfo.text ) {
			const info: LicenseInfo = { url: rightsInfo.url, title: rightsInfo.text };
			licenseCache.set( wikiKey, info );
			return info;
		}
	} catch {
		// Graceful fallback if mwn is not initialized or the request fails.
	}
	return undefined;
}

export function registerAllResources( server: McpServer ): void {
	const resourceTemplate = new ResourceTemplate(
		`${ WIKI_RESOURCE_URI_PREFIX }{wikiKey}`,
		{
			list: () => {
				const allWikis = wikiService.getAll();
				const resources: Resource[] = [];
				for ( const wikiKey in allWikis ) {
					const wikiConfig = allWikis[ wikiKey ];
					resources.push( {
						uri: `${ WIKI_RESOURCE_URI_PREFIX }${ wikiKey }`,
						name: `wikis/${ wikiKey }`,
						title: wikiConfig.sitename,
						description: `Wiki "${ wikiConfig.sitename }" hosted at ${ wikiConfig.server }`
					} );
				}
				return { resources };
			}
		}
	);

	server.resource( 'wikis', resourceTemplate, async ( uri, variables ) => {
		const wikiKey = variables.wikiKey as string;
		const wikiConfig = wikiService.get( wikiKey );

		if ( !wikiConfig ) {
			return { contents: [] };
		}

		const sanitized = wikiService.sanitize( wikiConfig );
		const result: Record<string, unknown> = { ...sanitized };

		const license = await getLicenseInfo( wikiKey );
		if ( license ) {
			result.license = license;
		}

		return {
			contents: [
				{
					uri: uri.toString(),
					text: JSON.stringify( result, null, 2 ),
					mimeType: 'application/json'
				}
			]
		};
	} );
}
