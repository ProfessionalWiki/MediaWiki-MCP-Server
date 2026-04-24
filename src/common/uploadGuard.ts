import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

export async function assertAllowedPath(
	filepath: string,
	allowedDirs: readonly string[]
): Promise<string> {
	if ( allowedDirs.length === 0 ) {
		throw new Error(
			'Upload rejected: this server has no upload directory configured. ' +
			'Set MCP_UPLOAD_DIRS=/path1:/path2 or add "uploadDirs": ["/path1"] to ' +
			'config.json to enable uploads.'
		);
	}
	if ( !isAbsolute( filepath ) ) {
		throw new Error(
			`Upload rejected: provide an absolute path (got "${ filepath }").`
		);
	}

	let resolved: string;
	try {
		resolved = await realpath( filepath );
	} catch ( err ) {
		if ( ( err as NodeJS.ErrnoException ).code === 'ENOENT' ) {
			throw new Error( `Upload rejected: file not found: ${ filepath }` );
		}
		throw err;
	}

	for ( const entry of allowedDirs ) {
		if ( resolved === entry || resolved.startsWith( entry + sep ) ) {
			return resolved;
		}
	}
	throw new Error(
		`Upload rejected: "${ resolved }" is not allowed by the configured upload directories.`
	);
}
