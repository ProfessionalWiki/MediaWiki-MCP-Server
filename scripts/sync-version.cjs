#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const {
	PACKAGE_JSON_PATH,
	SERVER_JSON_PATH,
	MANIFEST_JSON_PATH,
	DOCKERFILE_PATH
} = require( './constants.cjs' );

const packageJson = JSON.parse( fs.readFileSync( PACKAGE_JSON_PATH, 'utf8' ) );
const serverJson = JSON.parse( fs.readFileSync( SERVER_JSON_PATH, 'utf8' ) );
const manifestJson = JSON.parse( fs.readFileSync( MANIFEST_JSON_PATH, 'utf8' ) );
let dockerfile = fs.readFileSync( DOCKERFILE_PATH, 'utf8' );

const version = packageJson.version;

// Update server.json
serverJson.version = version;

// Update manifest.json
manifestJson.version = version;

// Update Dockerfile
const versionRegex = /(org\.opencontainers\.image\.version=")[^"]*(")/;
dockerfile = dockerfile.replace( versionRegex, `$1${ version }$2` );

fs.writeFileSync( SERVER_JSON_PATH, JSON.stringify( serverJson, null, 2 ) + '\n' );
fs.writeFileSync( MANIFEST_JSON_PATH, JSON.stringify( manifestJson, null, 2 ) + '\n' );
fs.writeFileSync( DOCKERFILE_PATH, dockerfile );

console.log( `✓ Updated server.json to version ${ version }` );
console.log( `✓ Updated manifest.json to version ${ version }` );
console.log( `✓ Updated Dockerfile to version ${ version }` );
