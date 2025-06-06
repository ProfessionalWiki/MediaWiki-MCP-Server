#!/usr/bin/env node

const args = process.argv.slice( 2 );
const scriptName = args[ 0 ] || 'stdio';

async function run(): Promise<void> {
	try {
		switch ( scriptName ) {
			case 'stdio':
				await import( './stdio.js' );
				break;
			case 'streamableHttp':
				await import( './streamableHttp.js' );
				break;
			default:
				console.error( `Unknown script: ${ scriptName }` );
				console.log( 'Available scripts:' );
				console.log( '- stdio' );
				console.log( '- streamableHttp' );
				throw new Error( `Unknown script: ${ scriptName }` );
		}
	} catch ( error ) {
		console.error( 'Error running script:', error );
		throw error;
	}
}

run();
