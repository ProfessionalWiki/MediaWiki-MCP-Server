// src/auth/tokenStore.ts
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { isErrnoException } from '../errors/isErrnoException.js';
import { getCredentialsPath } from './paths.js';

export interface StoredToken {
	access_token: string;
	refresh_token?: string;
	expires_at: string;
	scopes: string[];
	obtained_at: string;
}

export interface CredentialsFile {
	version: 1;
	tokens: Record<string, StoredToken>;
}

export interface TokenStore {
	read(): Promise<CredentialsFile>;
	put(wikiKey: string, entry: StoredToken): Promise<void>;
	delete(wikiKey: string): Promise<void>;
}

export function createTokenStore(): TokenStore {
	let writeChain: Promise<void> = Promise.resolve();

	async function read(): Promise<CredentialsFile> {
		const file = getCredentialsPath();
		let raw: string;
		try {
			raw = await fs.readFile(file, 'utf8');
		} catch (err: unknown) {
			if (isErrnoException(err) && err.code === 'ENOENT') {
				return { version: 1, tokens: {} };
			}
			throw err;
		}
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; structure validated immediately below
		let parsed: Partial<CredentialsFile>;
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; structure validated immediately below
			parsed = JSON.parse(raw) as Partial<CredentialsFile>;
		} catch {
			throw new Error(`Credentials file at ${file} invalid JSON; back up and remove to reset.`);
		}
		if (parsed.version !== 1) {
			throw new Error(
				`Credentials file at ${file} has unsupported version ${String(parsed.version)}; back up and remove to reset.`,
			);
		}
		return { version: 1, tokens: parsed.tokens ?? {} };
	}

	function chainedWrite(mutator: (cur: CredentialsFile) => CredentialsFile): Promise<void> {
		const next = writeChain.then(async () => {
			const file = getCredentialsPath();
			const cur = await readOrEmpty(file);
			const after = mutator(cur);
			await writeAtomic(file, after);
		});
		writeChain = next.catch(() => {});
		return next;
	}

	return {
		read,
		put(wikiKey, entry) {
			return chainedWrite((cur) => ({
				version: 1,
				tokens: { ...cur.tokens, [wikiKey]: entry },
			}));
		},
		delete(wikiKey) {
			return chainedWrite((cur) => {
				const next = { ...cur.tokens };
				delete next[wikiKey];
				return { version: 1, tokens: next };
			});
		},
	};
}

async function readOrEmpty(file: string): Promise<CredentialsFile> {
	try {
		const raw = await fs.readFile(file, 'utf8');
		// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; structure validated immediately below
		const parsed = JSON.parse(raw) as CredentialsFile;
		if (parsed.version !== 1) {
			throw new Error(
				`Credentials file at ${file} has unsupported version ${String(parsed.version)}; back up and remove to reset.`,
			);
		}
		return { version: 1, tokens: parsed.tokens ?? {} };
	} catch (err: unknown) {
		if (isErrnoException(err) && err.code === 'ENOENT') {
			return { version: 1, tokens: {} };
		}
		throw err;
	}
}

async function writeAtomic(file: string, content: CredentialsFile): Promise<void> {
	await fs.mkdir(path.dirname(file), { recursive: true });
	const tmp = `${file}.tmp`;
	await fs.writeFile(tmp, JSON.stringify(content, null, 2), { mode: 0o600 });
	if (process.platform !== 'win32') {
		await fs.chmod(tmp, 0o600);
	}
	await fs.rename(tmp, file);
}
