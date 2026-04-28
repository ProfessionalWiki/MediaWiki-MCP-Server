import { realpath } from 'node:fs/promises';
import { isAbsolute, sep } from 'node:path';

export class UploadValidationError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'UploadValidationError';
	}
}

export async function assertAllowedPath(
	filepath: string,
	allowedDirs: readonly string[],
): Promise<string> {
	if (allowedDirs.length === 0) {
		throw new UploadValidationError(
			'uploads are disabled on this server (no upload directories configured). ' +
				'Ask the operator to set MCP_UPLOAD_DIRS or "uploadDirs" in config.json; ' +
				'this is not something the model can fix by retrying.',
		);
	}
	if (!isAbsolute(filepath)) {
		throw new UploadValidationError(`provide an absolute path (got "${filepath}").`);
	}

	let resolved: string;
	try {
		resolved = await realpath(filepath);
	} catch (err) {
		if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
			throw new UploadValidationError(
				`file not found at "${filepath}". Verify the path exists and is inside an allowed upload directory.`,
			);
		}
		throw err;
	}

	for (const entry of allowedDirs) {
		if (resolved === entry || resolved.startsWith(entry + sep)) {
			return resolved;
		}
	}
	throw new UploadValidationError(
		`path "${resolved}" is outside the allowed upload directories. ` +
			`Allowed roots: ${allowedDirs.join(', ')}. ` +
			'If the caller-supplied path differed, a symlink resolved outside the allowlist.',
	);
}
