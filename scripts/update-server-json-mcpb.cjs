#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const crypto = require( 'crypto' );
const {
	PACKAGE_JSON_PATH,
	SERVER_JSON_PATH,
	MCPB_BUNDLE_PATH,
	MCPB_FILE
} = require( './constants.cjs' );

function getFileSha256( filePath ) {
	const fileBuffer = fs.readFileSync( filePath );
	const hashSum = crypto.createHash( 'sha256' );
	hashSum.update( fileBuffer );
	return hashSum.digest( 'hex' );
}

function main() {
	console.log( 'Updating server.json with MCP bundle details...' );

	if ( !fs.existsSync( MCPB_BUNDLE_PATH ) ) {
		console.error( 'Error: Bundle file not found at ' + MCPB_BUNDLE_PATH );
		throw new Error( 'Bundle file not found at ' + MCPB_BUNDLE_PATH );
	}

	const packageJson = JSON.parse( fs.readFileSync( PACKAGE_JSON_PATH, 'utf8' ) );
	const serverJson = JSON.parse( fs.readFileSync( SERVER_JSON_PATH, 'utf8' ) );

	const version = packageJson.version;
	const sha256 = getFileSha256( MCPB_BUNDLE_PATH );
	const downloadUrl = `https://github.com/ProfessionalWiki/MediaWiki-MCP-Server/releases/download/v${ version }/${ MCPB_FILE }`;

	console.log( `Version: ${ version }` );
	console.log( `Bundle SHA256: ${ sha256 }` );
	console.log( `Download URL: ${ downloadUrl }` );

	if ( serverJson.packages ) {
		const mcpbPackage = serverJson.packages.find( ( p ) => p.registryType === 'mcpb' );
		if ( mcpbPackage ) {
			mcpbPackage.fileSha256 = sha256;
			mcpbPackage.identifier = downloadUrl;
		}
	}

	fs.writeFileSync( SERVER_JSON_PATH, JSON.stringify( serverJson, null, 2 ) + '\n' );
	console.log( '✓ Updated server.json with bundle details successfully' );
}

main();
