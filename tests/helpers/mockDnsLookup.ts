import { vi } from 'vitest';
import type { LookupAddress, LookupAllOptions } from 'node:dns';
import { lookup } from 'node:dns/promises';

type LookupAll = (hostname: string, options: LookupAllOptions) => Promise<LookupAddress[]>;

// `dns/promises.lookup` is overloaded, and `vi.mocked( lookup )` types the spy
// from the single-address overload. Production calls the `{ all: true }` one,
// which resolves an array, so an array stub does not match the inferred type.
// Narrowing to the overload under test keeps the stub checked against the real
// return shape instead of being waved through with a cast at each call site.
// Requires the calling suite to have mocked `node:dns/promises`.
export function mockedLookupAll(): ReturnType<typeof vi.mocked<LookupAll>> {
	return vi.mocked<LookupAll>(lookup);
}
