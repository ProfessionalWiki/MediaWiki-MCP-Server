import { contextReturning } from '../../../helpers/rawRequest.ts';
import { describe, it, expect } from 'vitest';
import { neowikiMintSubjectIds } from '../../../../src/tools/extensions/neowiki/neowiki-mint-subject-ids.ts';

describe('neowiki-mint-subject-ids', () => {
	it('mints the requested number of subject IDs without a CSRF token', async () => {
		const { mock, ctx } = contextReturning({ subjectIds: ['s1demo6sssssss1', 's1demo6sssssss2'] });
		const result = await neowikiMintSubjectIds.handle({ count: 2 }, ctx);

		const call = mock.rawRequest.mock.calls[0][0] as {
			url: string;
			method: string;
			data: string;
			headers: Record<string, string>;
		};
		expect(call.url).toBe('https://test.wiki/w/rest.php/neowiki/v0/subject-ids');
		expect(call.method).toBe('POST');
		expect(JSON.parse(call.data)).toEqual({ count: 2 });
		expect(call.headers['X-CSRF-TOKEN']).toBeUndefined();
		expect(result.structuredContent).toEqual({
			subjectIds: ['s1demo6sssssss1', 's1demo6sssssss2'],
		});
	});
});
