import { vi } from 'vitest';
import { Mwn } from 'mwn';

export interface AnsweringWiki {
	mwn: Mwn;
	sentQuery: () => URLSearchParams;
}

// A real Mwn with only its HTTP layer stubbed, answering every request with
// `body`, so mwn's own request handling runs: a refused query surfaces however
// mwn surfaces it, which a mocked mwn method hides.
export function wikiAnswering(body: object): AnsweringWiki {
	const mwn = new Mwn({ apiUrl: 'https://test.wiki/w/api.php' });
	let sent: string | undefined;
	vi.spyOn(mwn, 'rawRequest').mockImplementation((async (request: { data?: string }) => {
		sent = request.data;
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
	};
}
