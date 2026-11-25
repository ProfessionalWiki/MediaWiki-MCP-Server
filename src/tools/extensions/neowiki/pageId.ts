import { z } from 'zod';
import type { ToolContext } from '../../../runtime/context.ts';
import { ClassifiedError } from '../../../errors/classifyError.ts';

interface PageInfoResponse {
	query?: { pages?: Array<{ pageid?: number; missing?: boolean }> };
}

interface PageRef {
	title?: string;
	pageId?: number;
}

/** The `title` and `pageId` parameters of a tool that acts on one wiki page, such as "the page to move the Subject to". */
export function pageRefShape(page: string): {
	title: z.ZodOptional<z.ZodString>;
	pageId: z.ZodOptional<z.ZodNumber>;
} {
	return {
		title: z.string().min(1).optional().describe(`Title of ${page}. Provide this OR pageId.`),
		pageId: z
			.number()
			.int()
			.positive()
			.optional()
			.describe(`Numeric MediaWiki page ID of ${page}. Provide this OR title.`),
	};
}

/**
 * The ID of the page a reference names. A page ID is taken as given, so a bad one surfaces as the
 * NeoWiki endpoint's 404; the wiki is asked only for a title.
 */
export async function pageIdOf(ctx: ToolContext, ref: PageRef): Promise<number> {
	if (ref.pageId !== undefined && ref.title === undefined) {
		return ref.pageId;
	}
	if (ref.title === undefined || ref.pageId !== undefined) {
		throw new ClassifiedError('invalid_input', 'Provide exactly one of title or pageId.');
	}

	const mwn = await ctx.mwn();
	// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- action=query info response shape; trusted at this boundary
	const info = (await mwn.request({
		action: 'query',
		titles: ref.title,
		formatversion: 2,
		format: 'json',
	})) as PageInfoResponse;
	const page = info.query?.pages?.[0];
	if (page === undefined || page.missing === true || typeof page.pageid !== 'number') {
		throw new ClassifiedError('not_found', `Page "${ref.title}" not found`);
	}
	return page.pageid;
}
