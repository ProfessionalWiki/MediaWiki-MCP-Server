#!/usr/bin/env node
'use strict';

const { execSync } = require( 'child_process' );
const fs = require( 'fs' );
const path = require( 'path' );
const {
	MCPB_FILE,
	MANIFEST_FILE,
	MANIFEST_JSON_PATH,
	ROOT_DIR
} = require( './constants.cjs' );

const MANIFEST_DEST = path.join( ROOT_DIR, MANIFEST_FILE );

function ensureManifest() {
	if ( fs.existsSync( MANIFEST_DEST ) ) {
		return false;
	}
	console.log( 'Copying manifest to root...' );
	fs.copyFileSync( MANIFEST_JSON_PATH, MANIFEST_DEST );
	return true;
}

function cleanupManifest() {
	console.log( 'Cleaning up temporary manifest...' );
	if ( fs.existsSync( MANIFEST_DEST ) ) {
		fs.unlinkSync( MANIFEST_DEST );
	}
}

function buildBundle() {
	console.log( 'Running mcpb pack...' );
	execSync( 'npx mcpb pack', { stdio: 'inherit' } );
}

function cleanBundle() {
	console.log( 'Running mcpb clean...' );
	execSync( `npx mcpb clean ${ MCPB_FILE }`, { stdio: 'inherit' } );
}

function removeBundleArtifact() {
	const bundlePath = path.join( ROOT_DIR, MCPB_FILE );
	if ( fs.existsSync( bundlePath ) ) {
		console.log( `Cleaning up ${ MCPB_FILE }...` );
		fs.unlinkSync( bundlePath );
	}
}

function main() {
	const args = process.argv.slice( 2 );
	const shouldClean = args.includes( '--clean' );
	let tempManifestCreated = false;

	console.log( 'Building MCP Bundle...' );

	try {
		tempManifestCreated = ensureManifest();
		buildBundle();
		cleanBundle();

		if ( shouldClean ) {
			removeBundleArtifact();
		}

		console.log( '✓ Bundle packed successfully.' );
	} finally {
		if ( tempManifestCreated ) {
			cleanupManifest();
		}
	}
}

main();
