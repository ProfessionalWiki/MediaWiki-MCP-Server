import type { Mwn } from 'mwn';

export interface MwnProvider {
	get( wikiKey?: string ): Promise<Mwn>;
	invalidate( wikiKey: string ): void;
}
