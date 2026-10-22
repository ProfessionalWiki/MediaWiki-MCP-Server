import { fetch, type Agent } from 'undici';
import { USER_AGENT } from '../../runtime/constants.ts';
import {
	assertPublicDestination,
	buildPinnedAgent,
	SsrfValidationError,
} from '../../outbound/ssrfGuard.ts';
import type { CimdFetchResult } from './cimd.ts';
import { errorMessage } from '../../errors/errorMessage.ts';

const DEFAULT_MAX_BYTES = 5 * 1024; // IETF CIMD draft recommended read cap.
const DEFAULT_TIMEOUT_MS = 5_000;

export class CimdFetchError extends Error {
	public constructor(message: string) {
		super(message);
		this.name = 'CimdFetchError';
	}
}

// Fetches a client_id metadata document under the CIMD security contract: https
// only, SSRF-guarded (special-use addresses rejected, DNS pinned), HTTP redirects
// NOT followed, an overall timeout, and a hard read cap. Any HTTP status is
// returned (the caller treats non-200 as an error); transport-level problems throw.
export async function fetchCimdDocument(
	url: string,
	opts?: { maxBytes?: number; timeoutMs?: number },
): Promise<CimdFetchResult> {
	const maxBytes = opts?.maxBytes ?? DEFAULT_MAX_BYTES;
	const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

	let parsed: URL;
	try {
		parsed = new URL(url);
	} catch {
		throw new CimdFetchError(`invalid URL: ${url}`);
	}
	if (parsed.protocol !== 'https:') {
		throw new CimdFetchError('CIMD documents must be fetched over https');
	}

	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), timeoutMs);
	let agent: Agent | undefined;
	try {
		const addresses = await assertPublicDestination(url);
		agent = buildPinnedAgent(addresses);
		const response = await fetch(url, {
			method: 'GET',
			headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
			redirect: 'manual', // MUST NOT follow redirects (IETF CIMD draft).
			dispatcher: agent,
			signal: controller.signal,
		});

		let total = 0;
		const chunks: Uint8Array[] = [];
		if (response.body !== null) {
			for await (const chunk of response.body) {
				total += chunk.length;
				if (total > maxBytes) {
					throw new CimdFetchError(`document exceeds ${maxBytes}-byte cap`);
				}
				chunks.push(chunk);
			}
		}
		return {
			status: response.status,
			body: Buffer.concat(chunks).toString('utf8'),
			cacheControl: response.headers.get('cache-control'),
		};
	} catch (e) {
		if (e instanceof CimdFetchError) {
			throw e;
		}
		if (e instanceof SsrfValidationError) {
			throw new CimdFetchError(`SSRF guard rejected the document URL: ${e.message}`);
		}
		throw new CimdFetchError(`could not fetch CIMD document: ${errorMessage(e)}`);
	} finally {
		clearTimeout(timer);
		agent?.destroy().catch(() => {});
	}
}
