import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import * as path from 'node:path';
import { isErrnoException } from '../../errors/isErrnoException.js';
import { getProxyStorePath } from '../paths.js';
import type { ProxyConfig } from './proxyConfig.js';
import { deriveKey, decrypt, encrypt } from './proxyStoreCrypto.js';
import {
	InMemoryProxyStore,
	type ClientRecord,
	type CodeRecord,
	type DurableSnapshot,
	type ProxyStore,
	type TransactionRecord,
	type UpstreamToken,
} from './proxyStore.js';

export class ProxyStorePersistenceError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'ProxyStorePersistenceError';
	}
}

/**
 * Wraps an InMemoryProxyStore and mirrors its durable slice (client registrations
 * and upstream tokens) to an encrypted file. Reads and the atomic refresh-rotation
 * claim delegate straight through and stay in memory. Upstream-token mutations write
 * through synchronously — durable before the method returns, so a rotated refresh
 * token / committed refreshId survives a restart. Client registrations defer to a
 * coalesced flush so the unauthenticated /register path cannot force a whole-file
 * rewrite per call. Every disk write is synchronous, so a write-through and a deferred
 * flush can never overlap and clobber each other.
 *
 * This store is single-instance only: the fixed tmp path and whole-snapshot rewrite
 * assume one writing process. Write-through means the value survives a process
 * restart (it is in the OS page cache after the atomic rename); it is not fsync'd,
 * so an OS crash or power loss can still lose the most recent write.
 */
export class PersistentProxyStore implements ProxyStore {
	private dirty = false;
	private flushScheduled = false;

	public constructor(
		private inner: InMemoryProxyStore,
		private file: string,
		private key: Buffer,
		private onError: (err: Error) => void = () => {},
	) {}

	// --- durable mutations ---

	public putClient(c: Omit<ClientRecord, 'clientId' | 'createdAt'>): ClientRecord {
		const rec = this.inner.putClient(c);
		this.scheduleFlush();
		return rec;
	}

	public putUpstreamToken(t: UpstreamToken): string {
		const id = this.inner.putUpstreamToken(t);
		this.flushSync();
		return id;
	}

	public updateUpstreamToken(id: string, t: UpstreamToken): void {
		this.inner.updateUpstreamToken(id, t);
		this.flushSync();
	}

	public setRefreshId(id: string, refreshId: string): void {
		this.inner.setRefreshId(id, refreshId);
		this.flushSync();
	}

	public deleteUpstreamToken(id: string): void {
		this.inner.deleteUpstreamToken(id);
		this.flushSync();
	}

	public finishRefreshRotation(id: string, newRefreshId?: string): void {
		this.inner.finishRefreshRotation(id, newRefreshId);
		// Only a committed rotation changes durable state; an abandoned claim
		// (no newRefreshId) touches just the in-memory refreshing set.
		if (newRefreshId !== undefined) {
			this.flushSync();
		}
	}

	// --- pass-through reads + ephemeral ops ---

	public getClient(id: string): ClientRecord | undefined {
		return this.inner.getClient(id);
	}

	public putTransaction(id: string, t: TransactionRecord, ttlMs?: number): void {
		this.inner.putTransaction(id, t, ttlMs);
	}

	public getTransaction(id: string): TransactionRecord | undefined {
		return this.inner.getTransaction(id);
	}

	public deleteTransaction(id: string): void {
		this.inner.deleteTransaction(id);
	}

	public putCode(code: string, r: CodeRecord, ttlMs?: number): void {
		this.inner.putCode(code, r, ttlMs);
	}

	public consumeCode(code: string): CodeRecord | undefined {
		return this.inner.consumeCode(code);
	}

	public getUpstreamToken(id: string): UpstreamToken | undefined {
		return this.inner.getUpstreamToken(id);
	}

	public beginRefreshRotation(id: string, expectedRefreshId: string): boolean {
		return this.inner.beginRefreshRotation(id, expectedRefreshId);
	}

	// --- persistence internals ---

	/**
	 * Load the durable slice from disk. Missing file → empty store (fresh deploy).
	 * A decrypt / parse / version failure throws ProxyStorePersistenceError, which the
	 * bootstrap surfaces as a refuse-to-start (no silent mass sign-out).
	 */
	public hydrate(): void {
		let blob: Buffer;
		try {
			blob = readFileSync(this.file);
		} catch (err: unknown) {
			if (isErrnoException(err) && err.code === 'ENOENT') {
				return;
			}
			throw err;
		}
		let json: string;
		try {
			json = decrypt(this.key, blob).toString('utf8');
		} catch {
			throw new ProxyStorePersistenceError(
				`Proxy store at ${this.file} could not be decrypted (wrong MCP_OAUTH_JWT_SIGNING_KEY, or a tampered/corrupt file); back up and remove it to reset.`,
			);
		}
		let snapshot: DurableSnapshot;
		try {
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- post-JSON.parse boundary; restoreDurable validates version
			snapshot = JSON.parse(json) as DurableSnapshot;
		} catch {
			throw new ProxyStorePersistenceError(
				`Proxy store at ${this.file} decrypted to invalid JSON; back up and remove it to reset.`,
			);
		}
		try {
			this.inner.restoreDurable(snapshot);
		} catch (err: unknown) {
			throw new ProxyStorePersistenceError(
				`Proxy store at ${this.file}: ${err instanceof Error ? err.message : String(err)}; back up and remove it to reset.`,
			);
		}
	}

	private scheduleFlush(): void {
		this.dirty = true;
		if (this.flushScheduled) {
			return;
		}
		this.flushScheduled = true;
		setImmediate(() => {
			this.flushScheduled = false;
			if (this.dirty) {
				this.flushSync();
			}
		});
	}

	private flushSync(): void {
		try {
			const json = JSON.stringify(this.inner.snapshotDurable());
			const blob = encrypt(this.key, Buffer.from(json, 'utf8'));
			mkdirSync(path.dirname(this.file), { recursive: true });
			const tmp = `${this.file}.tmp`;
			writeFileSync(tmp, blob, { mode: 0o600 });
			renameSync(tmp, this.file);
			this.dirty = false;
		} catch (err: unknown) {
			// Best-effort durability: a disk failure must not break the live request. The
			// record stays valid in memory; persistence is re-attempted by the next
			// whole-snapshot flush — the deferred `dirty` flag drives it on the
			// registration path, and any later token write-through re-persists the whole
			// snapshot on the token path (where `dirty` is usually already clear).
			try {
				this.onError(err instanceof Error ? err : new Error(String(err)));
			} catch {
				// An onError handler that itself throws must not escape into the request.
			}
		}
	}
}

/**
 * Build the proxy store for a resolved proxy config. No config (proxy disabled) →
 * a plain in-memory store. Otherwise a PersistentProxyStore hydrated synchronously
 * from disk before it is returned (and thus before the server binds).
 */
export function createProxyStore(
	pc: ProxyConfig | null,
	opts: { onError?: (err: Error) => void } = {},
): ProxyStore {
	if (!pc) {
		return new InMemoryProxyStore();
	}
	const store = new PersistentProxyStore(
		new InMemoryProxyStore(),
		getProxyStorePath(),
		deriveKey(pc.signingKey),
		opts.onError,
	);
	store.hydrate();
	return store;
}
