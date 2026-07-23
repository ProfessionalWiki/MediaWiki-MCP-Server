import { randomUUID } from 'node:crypto';

export interface ClientRecord {
	clientId: string;
	redirectUris: string[];
	scopes: string[];
	name: string;
	createdAt: number;
}

export interface TransactionRecord {
	clientId: string;
	clientRedirectUri: string;
	clientState: string;
	clientCodeChallenge: string;
	clientCodeChallengeMethod: string;
	scopes: string[];
	proxyVerifier: string;
}

export interface CodeRecord {
	clientId: string;
	clientRedirectUri: string;
	clientCodeChallenge: string;
	scopes: string[];
	upstreamTokenId: string;
}

export interface UpstreamToken {
	accessToken: string;
	refreshToken?: string;
	expiresAt: number;
	// The rotating id (`rid`) of the currently-valid downstream refresh token for
	// this upstream token. A presented refresh token whose rid differs is a
	// superseded/replayed token (OAuth 2.1 §4.3.1 reuse detection).
	refreshId?: string;
}

export interface DurableSnapshot {
	version: 1;
	// Insertion order preserved so FIFO eviction survives a restore.
	clients: ClientRecord[];
	// [ upstreamTokenId, token ] pairs; the id is not carried on the record.
	upstream: Array<[string, UpstreamToken]>;
}

// Live counts of the durable slice, for observability. `upstreamTokens` is the
// unbounded one (it grows with cumulative sign-ins); `clients` is FIFO-capped.
export interface ProxyStoreStats {
	upstreamTokens: number;
	clients: number;
}

const TXN_TTL_MS = 15 * 60 * 1000;
const CODE_TTL_MS = 5 * 60 * 1000;

// /register is unauthenticated, so registered clients accumulate without bound
// unless capped. Evict the oldest (FIFO, by Map insertion order) once this many
// are held, keeping memory bounded against /register spam.
const DEFAULT_MAX_CLIENTS = 10_000;

export interface ProxyStore {
	putClient(c: Omit<ClientRecord, 'clientId' | 'createdAt'>): ClientRecord;
	getClient(id: string): ClientRecord | undefined;
	putTransaction(id: string, t: TransactionRecord, ttlMs?: number): void;
	getTransaction(id: string): TransactionRecord | undefined;
	deleteTransaction(id: string): void;
	putCode(code: string, r: CodeRecord, ttlMs?: number): void;
	consumeCode(code: string): CodeRecord | undefined;
	putUpstreamToken(t: UpstreamToken): string;
	getUpstreamToken(id: string): UpstreamToken | undefined;
	updateUpstreamToken(id: string, t: UpstreamToken): void;
	setRefreshId(id: string, refreshId: string): void;
	deleteUpstreamToken(id: string): void;
	beginRefreshRotation(id: string, expectedRefreshId: string): boolean;
	finishRefreshRotation(id: string, newRefreshId?: string): void;
	stats(): ProxyStoreStats;
}

interface Expiring<T> {
	value: T;
	expiresAt: number;
}

export class InMemoryProxyStore implements ProxyStore {
	private clients = new Map<string, ClientRecord>();
	private txns = new Map<string, Expiring<TransactionRecord>>();
	private codes = new Map<string, Expiring<CodeRecord>>();
	private upstream = new Map<string, UpstreamToken>();
	// Upstream-token ids with a refresh rotation currently in flight. Used to detect
	// a concurrent presentation of the same refresh token (reuse) before either
	// request has committed its rotated id.
	private refreshing = new Set<string>();

	public constructor(
		private now: () => number = Date.now,
		private maxClients: number = DEFAULT_MAX_CLIENTS,
	) {}

	public putClient(c: Omit<ClientRecord, 'clientId' | 'createdAt'>): ClientRecord {
		const rec: ClientRecord = { ...c, clientId: `mcp-${randomUUID()}`, createdAt: this.now() };
		// FIFO eviction: drop the oldest registration before exceeding the cap.
		// Map preserves insertion order, so the first key is the oldest.
		while (this.clients.size >= this.maxClients) {
			const oldest = this.clients.keys().next().value;
			if (oldest === undefined) {
				break;
			}
			this.clients.delete(oldest);
		}
		this.clients.set(rec.clientId, rec);
		return rec;
	}

	public getClient(id: string): ClientRecord | undefined {
		return this.clients.get(id);
	}

	public stats(): ProxyStoreStats {
		return { upstreamTokens: this.upstream.size, clients: this.clients.size };
	}

	public putTransaction(id: string, t: TransactionRecord, ttlMs = TXN_TTL_MS): void {
		this.txns.set(id, { value: t, expiresAt: this.now() + ttlMs });
	}

	public getTransaction(id: string): TransactionRecord | undefined {
		const e = this.txns.get(id);
		if (!e) {
			return undefined;
		}
		if (e.expiresAt < this.now()) {
			this.txns.delete(id);
			return undefined;
		}
		return e.value;
	}

	public deleteTransaction(id: string): void {
		this.txns.delete(id);
	}

	public putCode(code: string, r: CodeRecord, ttlMs = CODE_TTL_MS): void {
		this.codes.set(code, { value: r, expiresAt: this.now() + ttlMs });
	}

	public consumeCode(code: string): CodeRecord | undefined {
		const e = this.codes.get(code);
		this.codes.delete(code); // one-time regardless of expiry
		if (!e || e.expiresAt < this.now()) {
			return undefined;
		}
		return e.value;
	}

	public putUpstreamToken(t: UpstreamToken): string {
		const id = randomUUID();
		this.upstream.set(id, t);
		return id;
	}

	public getUpstreamToken(id: string): UpstreamToken | undefined {
		return this.upstream.get(id);
	}

	public updateUpstreamToken(id: string, t: UpstreamToken): void {
		// Merge so fields not carried by the update (notably refreshId) survive — but
		// never RESURRECT a token that was deleted (e.g. family-revoked) concurrently.
		const existing = this.upstream.get(id);
		if (!existing) {
			return;
		}
		this.upstream.set(id, { ...existing, ...t });
	}

	public setRefreshId(id: string, refreshId: string): void {
		const existing = this.upstream.get(id);
		if (existing) {
			this.upstream.set(id, { ...existing, refreshId });
		}
	}

	public deleteUpstreamToken(id: string): void {
		this.upstream.delete(id);
		this.refreshing.delete(id);
	}

	// Atomically (synchronously, in one event-loop turn) claim a refresh rotation:
	// the token must exist, its current refreshId must match the presented one, and
	// no rotation may already be in flight. Returns false otherwise — the caller
	// treats that as reuse. Claiming BEFORE the upstream refresh await is what makes
	// a concurrent presentation of the same refresh token detectable.
	public beginRefreshRotation(id: string, expectedRefreshId: string): boolean {
		const existing = this.upstream.get(id);
		if (!existing || existing.refreshId !== expectedRefreshId) {
			return false;
		}
		if (this.refreshing.has(id)) {
			return false;
		}
		this.refreshing.add(id);
		return true;
	}

	// Release the in-flight claim. With a newRefreshId the rotation is committed
	// (success); without one the claim is abandoned and the current refreshId stays
	// valid, so a retry after a transient upstream failure can reuse the same token.
	public finishRefreshRotation(id: string, newRefreshId?: string): void {
		this.refreshing.delete(id);
		if (newRefreshId !== undefined) {
			this.setRefreshId(id, newRefreshId);
		}
	}

	public snapshotDurable(): DurableSnapshot {
		return {
			version: 1,
			clients: [...this.clients.values()],
			upstream: [...this.upstream.entries()],
		};
	}

	public restoreDurable(snapshot: DurableSnapshot): void {
		if (snapshot.version !== 1) {
			throw new Error(`unsupported proxy store snapshot version ${String(snapshot.version)}`);
		}
		this.clients.clear();
		for (const c of snapshot.clients) {
			this.clients.set(c.clientId, c);
		}
		this.upstream.clear();
		for (const [id, t] of snapshot.upstream) {
			this.upstream.set(id, t);
		}
		// transactions, codes, and the refreshing set are ephemeral: left empty on purpose.
	}
}
