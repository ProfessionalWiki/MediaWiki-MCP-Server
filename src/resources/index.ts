/* eslint-disable n/no-missing-import */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../common/constants.js';
import { getMwn } from '../common/mwn.js';

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

		try {
			const mwn = await getMwn();
			const response = await mwn.request( {
				action: 'query',
				meta: 'siteinfo',
				siprop: 'rightsinfo',
				formatversion: '2'
			} );

			const rightsInfo = response.query?.rightsinfo;
			if ( rightsInfo ) {
				result.license = {
					url: rightsInfo.url,
					title: rightsInfo.text
				};
			}
		} catch {
			// Graceful fallback if mwn is not initialized
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
