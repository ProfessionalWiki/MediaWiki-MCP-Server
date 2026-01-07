'use strict';

const path = require( 'path' );

const ROOT_DIR = path.resolve( __dirname, '..' );
const MCPB_FILE = 'MediaWiki-MCP-Server.mcpb';
const MANIFEST_FILE = 'manifest.json';

module.exports = {
	ROOT_DIR,
	MCPB_FILE,
	MANIFEST_FILE,
	PACKAGE_JSON_PATH: path.join( ROOT_DIR, 'package.json' ),
	SERVER_JSON_PATH: path.join( ROOT_DIR, 'server.json' ),
	MANIFEST_JSON_PATH: path.join( ROOT_DIR, 'mcpb', MANIFEST_FILE ),
	DOCKERFILE_PATH: path.join( ROOT_DIR, 'Dockerfile' ),
	MCPB_BUNDLE_PATH: path.join( ROOT_DIR, MCPB_FILE )
};
