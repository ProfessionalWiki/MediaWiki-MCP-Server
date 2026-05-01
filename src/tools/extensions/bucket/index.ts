import type { ExtensionPack } from '../types.js';
import { bucketQuery } from '../../bucket-query.js';

export const bucketPack: ExtensionPack = {
	id: 'bucket',
	extensionNames: ['Bucket'],
	tools: [bucketQuery],
};
