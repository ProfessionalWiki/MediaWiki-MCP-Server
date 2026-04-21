import { describe, it, expect, vi, beforeEach } from 'vitest';
/* eslint-disable n/no-missing-import */
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
/* eslint-enable n/no-missing-import */

vi.mock( '../../src/common/wikiService.js', () => ( {
	wikiService: {
		isWikiManagementAllowed: vi.fn()
	}
} ) );

import { wikiService } from '../../src/common/wikiService.js';
import { registerAllTools } from '../../src/tools/index.js';

async function connectClientAndServer(): Promise<{ client: Client; server: McpServer }> {
	const server = new McpServer( { name: 'test', version: '0.0.0' } );
	registerAllTools( server );
	const client = new Client( { name: 'test-client', version: '0.0.0' } );
	const [ clientTransport, serverTransport ] = InMemoryTransport.createLinkedPair();
	await Promise.all( [
		server.connect( serverTransport ),
		client.connect( clientTransport )
	] );
	return { client, server };
}

describe( 'registerAllTools', () => {
	beforeEach( () => {
		vi.clearAllMocks();
	} );

	it( 'lists add-wiki and remove-wiki when wiki management is allowed', async () => {
		vi.mocked( wikiService.isWikiManagementAllowed ).mockReturnValue( true );
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map( ( t ) => t.name );

		expect( names ).toContain( 'add-wiki' );
		expect( names ).toContain( 'remove-wiki' );
		expect( names ).toContain( 'get-page' );
	} );

	it( 'omits add-wiki and remove-wiki from listTools when wiki management is disallowed', async () => {
		vi.mocked( wikiService.isWikiManagementAllowed ).mockReturnValue( false );
		const { client } = await connectClientAndServer();

		const { tools } = await client.listTools();
		const names = tools.map( ( t ) => t.name );

		expect( names ).not.toContain( 'add-wiki' );
		expect( names ).not.toContain( 'remove-wiki' );
		expect( names ).toContain( 'get-page' );
		expect( names ).toContain( 'set-wiki' );
	} );

	it( 'rejects calls to add-wiki with a disabled error when wiki management is disallowed', async () => {
		vi.mocked( wikiService.isWikiManagementAllowed ).mockReturnValue( false );
		const { client } = await connectClientAndServer();

		const result = await client.callTool( {
			name: 'add-wiki',
			arguments: { wikiUrl: 'https://en.wikipedia.org' }
		} );

		expect( result.isError ).toBe( true );
		const content = result.content as Array<{ type: string; text: string }>;
		expect( content[ 0 ].text ).toMatch( /Tool add-wiki disabled/ );
	} );
} );
