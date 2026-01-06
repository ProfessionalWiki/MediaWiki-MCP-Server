#!/usr/bin/env node
'use strict';

const { execSync } = require( 'child_process' );
const fs = require( 'fs' );
const path = require( 'path' );

const MCPB_FILE = 'MediaWiki-MCP-Server.mcpb';
const MANIFEST_FILE = 'manifest.json';
const MANIFEST_SRC = path.join( process.cwd(), 'mcpb', MANIFEST_FILE );
const MANIFEST_DEST = path.join( process.cwd(), MANIFEST_FILE );

function ensureManifest() {
	if ( fs.existsSync( MANIFEST_DEST ) ) {
		return false;
	}
	console.log( 'Copying manifest to root...' );
	fs.copyFileSync( MANIFEST_SRC, MANIFEST_DEST );
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
	if ( fs.existsSync( MCPB_FILE ) ) {
		console.log( `Cleaning up ${ MCPB_FILE }...` );
		fs.unlinkSync( MCPB_FILE );
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
