import type { Mwn } from 'mwn';

export interface SectionService {
	list( mwn: Mwn, title: string ): Promise<string[]>;
}
