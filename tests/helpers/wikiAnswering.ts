import { vi } from 'vitest';
import { Mwn } from 'mwn';

export interface AnsweringWiki {
	mwn: Mwn;
	sentQuery: () => URLSearchParams;
	/** The abort signal the last request carried, if any. */
	sentSignal: () => AbortSignal | undefined;
}

// A real Mwn with only its HTTP layer stubbed, answering every request with
// `body`, so mwn's own request handling runs: a refused query surfaces however
// mwn surfaces it, which a mocked mwn method hides.
export function wikiAnswering(body: object): AnsweringWiki {
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	let sent: string | undefined;
	let signal: AbortSignal | undefined;
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: {
		data?: string;
		signal?: AbortSignal;
	}) => {
		sent = request.data;
		signal = request.signal;
		return { data: body };
	}) as never);
	return {
		mwn,
		sentQuery: () => {
			if (sent === undefined) {
				throw new Error('No query reached the wiki');
			}
			return new URLSearchParams(sent);
		},
		sentSignal: () => signal,
	};
}
