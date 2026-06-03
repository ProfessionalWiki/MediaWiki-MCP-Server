import type { ExtensionPack } from '../types.js';
import { neowikiListSchemas } from './neowiki-list-schemas.js';
import { neowikiGetSchema } from './neowiki-get-schema.js';
import { neowikiCypherQuery } from './neowiki-cypher-query.js';

export const neowikiPack: ExtensionPack = {
	id: 'neowiki',
	extensionNames: ['NeoWiki'],
	tools: [neowikiListSchemas, neowikiGetSchema, neowikiCypherQuery],
};
