import type { Mwn } from 'mwn';

export interface SectionService {
	list(mwn: Mwn, title: string): Promise<string[]>;
}

interface PageSectionsApi {
	line?: string;
}

export class SectionServiceImpl implements SectionService {
	public async list(mwn: Mwn, title: string): Promise<string[]> {
		const response =
			// oxlint-disable-next-line typescript/no-unsafe-type-assertion -- mwn API response shape; trusted at this boundary
			(await mwn.request({
				action: 'parse',
				page: title,
				prop: 'sections',
				formatversion: '2',
			})) as { parse?: { sections?: PageSectionsApi[] } } | undefined;
		const apiSections: PageSectionsApi[] = response?.parse?.sections ?? [];
		return ['', ...apiSections.map((s) => s.line ?? '')];
	}
}
