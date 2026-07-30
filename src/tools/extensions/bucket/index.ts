import type { ExtensionPack } from '../types.ts';
import { bucketQuery } from './bucket-query.ts';

export const bucketPack: ExtensionPack = {
	id: 'bucket',
	extensionNames: ['Bucket'],
	tools: [bucketQuery],
};
