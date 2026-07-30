import type { ExtensionPack } from '../types.ts';
import { smwQuery } from './smw-query.ts';
import { smwListProperties } from './smw-list-properties.ts';

export const smwPack: ExtensionPack = {
	id: 'smw',
	extensionNames: ['SemanticMediaWiki'],
	tools: [smwQuery, smwListProperties],
};
