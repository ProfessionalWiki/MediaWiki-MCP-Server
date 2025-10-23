#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const path = require( 'path' );

const packageJsonPath = path.join( __dirname, '..', 'package.json' );
const serverJsonPath = path.join( __dirname, '..', 'server.json' );

const packageJson = JSON.parse( fs.readFileSync( packageJsonPath, 'utf8' ) );
const serverJson = JSON.parse( fs.readFileSync( serverJsonPath, 'utf8' ) );

const version = packageJson.version;

serverJson.version = version;
if ( serverJson.packages && serverJson.packages[ 0 ] ) {
	serverJson.packages[ 0 ].version = version;
}

fs.writeFileSync( serverJsonPath, JSON.stringify( serverJson, null, 2 ) + '\n' );

console.log( `✓ Updated server.json to version ${ version }` );
