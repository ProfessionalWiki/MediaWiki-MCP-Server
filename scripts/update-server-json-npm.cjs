#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const {
	PACKAGE_JSON_PATH,
	SERVER_JSON_PATH
} = require( './constants.cjs' );

function main() {
	console.log( 'Updating server.json with npm package version...' );

	const packageJson = JSON.parse( fs.readFileSync( PACKAGE_JSON_PATH, 'utf8' ) );
	const serverJson = JSON.parse( fs.readFileSync( SERVER_JSON_PATH, 'utf8' ) );

	const version = packageJson.version;
	console.log( `Version: ${ version }` );

	serverJson.version = version;

	if ( serverJson.packages ) {
		const npmPackage = serverJson.packages.find( ( p ) => p.registryType === 'npm' );
		if ( npmPackage ) {
			npmPackage.version = version;
		}
	}

	fs.writeFileSync( SERVER_JSON_PATH, JSON.stringify( serverJson, null, 2 ) + '\n' );
	console.log( '✓ Updated server.json with npm version successfully' );
}

main();
