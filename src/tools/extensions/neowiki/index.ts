import type { ExtensionPack } from '../types.js';
import { neowikiListSchemas } from './neowiki-list-schemas.js';

export const neowikiPack: ExtensionPack = {
	id: 'neowiki',
	extensionNames: ['NeoWiki'],
	tools: [neowikiListSchemas],
};
