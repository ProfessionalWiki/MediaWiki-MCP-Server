#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const packageJsonPath = path.join( __dirname, '../package.json' );
const serverJsonPath = path.join( __dirname, '../server.json' );
const manifestJsonPath = path.join( __dirname, '../mcpb/manifest.json' );
const dockerfilePath = path.join( __dirname, '../Dockerfile' );

const packageJson = JSON.parse( fs.readFileSync( packageJsonPath, 'utf8' ) );
const serverJson = JSON.parse( fs.readFileSync( serverJsonPath, 'utf8' ) );
const manifestJson = JSON.parse( fs.readFileSync( manifestJsonPath, 'utf8' ) );
let dockerfile = fs.readFileSync( dockerfilePath, 'utf8' );

const version = packageJson.version;

// Update server.json
serverJson.version = version;
if ( serverJson.packages && serverJson.packages[ 0 ] ) {
	serverJson.packages[ 0 ].version = version;
}

// Update manifest.json
manifestJson.version = version;

// Update Dockerfile
const versionRegex = /(org\.opencontainers\.image\.version=")[^"]*(")/;
dockerfile = dockerfile.replace( versionRegex, `$1${ version }$2` );

fs.writeFileSync( serverJsonPath, JSON.stringify( serverJson, null, 2 ) + '\n' );
fs.writeFileSync( manifestJsonPath, JSON.stringify( manifestJson, null, 2 ) + '\n' );
fs.writeFileSync( dockerfilePath, dockerfile );

console.log( `✓ Updated server.json to version ${ version }` );
console.log( `✓ Updated manifest.json to version ${ version }` );
console.log( `✓ Updated Dockerfile to version ${ version }` );
