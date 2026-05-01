import type { ExtensionPack } from '../types.js';
import { smwQuery } from './smw-query.js';
import { smwListProperties } from './smw-list-properties.js';

export const smwPack: ExtensionPack = {
	id: 'smw',
	extensionNames: ['SemanticMediaWiki'],
	tools: [smwQuery, smwListProperties],
};
