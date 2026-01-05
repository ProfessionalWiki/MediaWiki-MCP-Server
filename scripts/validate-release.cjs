#!/usr/bin/env node
'use strict';

const { execSync } = require( 'child_process' );
const fs = require( 'fs' );
const Ajv = require( 'ajv' );
const addFormats = require( 'ajv-formats' );
const path = require( 'path' );

function runCommand( command, quiet = false ) {
	try {
		console.log( `Running: ${ command }` );
		execSync( command, { stdio: quiet ? [ 'ignore', 'ignore', 'inherit' ] : 'inherit' } );
		return true;
	} catch ( error ) {
		console.error( `Failed: ${ command }` );
		return false;
	}
}

async function validateServerJson() {
	console.log( '\nValidating server.json...' );
	const serverJsonPath = path.join( process.cwd(), 'server.json' );
	const serverJson = JSON.parse( fs.readFileSync( serverJsonPath, 'utf8' ) );

	const schemaUrl = serverJson.$schema;
	if ( !schemaUrl ) {
		console.error( 'server.json missing $schema' );
		return false;
	}

	try {
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
			return false;
		}
		console.log( '✓ server.json is valid' );
		return true;
	} catch ( e ) {
		console.error( `Error validating server.json: ${ e.message }` );
		return false;
	}
}

function validateMcpbManifest() {
	console.log( '\nValidating mcpb/manifest.json...' );
	return runCommand( 'npx mcpb validate mcpb/manifest.json' );
}

function checkLintAndBuild() {
	console.log( '\nRunning lint and build...' );
	if ( !runCommand( 'npm run lint' ) ) {
		return false;
	}
	if ( !runCommand( 'npm run build' ) ) {
		return false;
	}
	return true;
}

function checkBundlePack() {
	console.log( '\nChecking bundle packing...' );
	const manifestPath = 'manifest.json';
	const tempManifestCreated = !fs.existsSync( manifestPath );

	try {
		if ( tempManifestCreated ) {
			fs.copyFileSync( 'mcpb/manifest.json', manifestPath );
		}

		if ( !runCommand( 'npx mcpb pack', true ) ) {
			return false;
		}

		const files = fs.readdirSync( process.cwd() );
		const mcpbFile = files.find( f => f.endsWith( '.mcpb' ) );
		if ( mcpbFile ) {
			fs.unlinkSync( mcpbFile );
			console.log( `✓ Created and cleaned up ${ mcpbFile }` );
		} else {
			console.error( 'No .mcpb file generated' );
			return false;
		}

		return true;
	} catch ( e ) {
		console.error( `Error in bundle pack check: ${ e.message }` );
		return false;
	} finally {
		if ( tempManifestCreated && fs.existsSync( manifestPath ) ) {
			fs.unlinkSync( manifestPath );
		}
	}
}

async function main() {
	let success = true;

	if ( !checkLintAndBuild() ) {
		success = false;
	}

	if ( !await validateServerJson() ) {
		success = false;
	}
	if ( !validateMcpbManifest() ) {
		success = false;
	}

	if ( !checkBundlePack() ) {
		success = false;
	}

	if ( success ) {
		console.log( '\n✓ All checks passed! Repo is ready for release.' );
		process.exit( 0 );
	} else {
		console.error( '\nSome checks failed.' );
		process.exit( 1 );
	}
}

main();
