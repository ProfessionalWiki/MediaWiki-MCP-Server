/* eslint-disable n/no-missing-import */
import { ResourceTemplate } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { Resource } from '@modelcontextprotocol/sdk/types.js';
/* eslint-enable n/no-missing-import */
import { wikiService } from '../common/wikiService.js';
import { WIKI_RESOURCE_URI_PREFIX } from '../common/constants.js';

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

	server.resource( 'wikis', resourceTemplate, ( uri, variables ) => {
		const wikiKey = variables.wikiKey as string;
		const wikiConfig = wikiService.get( wikiKey );

		if ( !wikiConfig ) {
			return { contents: [] };
		}

		return {
			contents: [
				{
					uri: uri.toString(),
					text: JSON.stringify( wikiService.sanitize( wikiConfig ), null, 2 ),
					mimeType: 'application/json'
				}
			]
		};
	} );
}
