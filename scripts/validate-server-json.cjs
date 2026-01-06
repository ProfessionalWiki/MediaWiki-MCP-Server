#!/usr/bin/env node
'use strict';

const fs = require( 'fs' );
const Ajv = require( 'ajv' );
const addFormats = require( 'ajv-formats' );
const path = require( 'path' );

( async () => {
	console.log( '\nValidating server.json...' );
	const serverJsonPath = path.join( process.cwd(), 'server.json' );
	const serverJson = JSON.parse( fs.readFileSync( serverJsonPath, 'utf8' ) );

	const schemaUrl = serverJson.$schema;
	if ( !schemaUrl ) {
		console.error( 'server.json missing $schema' );
		process.exitCode = 1;
		return;
	}

	try {
		// eslint-disable-next-line n/no-unsupported-features/node-builtins
		const response = await fetch( schemaUrl );
		if ( !response.ok ) {
			throw new Error( `Failed to fetch schema from ${ schemaUrl }: ${ response.status } ${ response.statusText }` );
		}
		const schema = await response.json();

		const ajv = new Ajv( { strict: false } );
		addFormats( ajv );
		const validate = ajv.compile( schema );
		const valid = validate( serverJson );

		if ( !valid ) {
			console.error( 'server.json validation failed:' );
			console.error( validate.errors );
			process.exitCode = 1;
			return;
		}
		console.log( '✓ server.json is valid' );
	} catch ( e ) {
		console.error( `Error validating server.json: ${ e.message }` );
		process.exitCode = 1;
	}
} )();
