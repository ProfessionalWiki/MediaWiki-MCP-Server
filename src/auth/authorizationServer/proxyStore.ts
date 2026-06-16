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
		this.upstream.set(id, t);
	}
}
