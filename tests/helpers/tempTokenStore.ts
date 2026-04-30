// tests/helpers/tempTokenStore.ts
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, vi } from 'vitest';

export interface TempStoreHandle {
	readonly file: string;
	readonly dir: string;
}

export function useTempTokenStore(): TempStoreHandle {
	const handle: TempStoreHandle = { file: '', dir: '' };

	beforeEach(() => {
		(handle as { dir: string }).dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mwmcp-store-'));
		(handle as { file: string }).file = path.join(handle.dir, 'credentials.json');
		vi.stubEnv('MCP_OAUTH_CREDENTIALS_FILE', handle.file);
	});
	afterEach(() => {
		fs.rmSync(handle.dir, { recursive: true, force: true });
		vi.unstubAllEnvs();
	});
	return handle;
}
