import type { ExtensionPack } from './types.ts';
import { smwPack } from './smw/index.ts';
import { bucketPack } from './bucket/index.ts';
import { cargoPack } from './cargo/index.ts';
import { neowikiPack } from './neowiki/index.ts';

export type { ExtensionPack } from './types.ts';
export const extensionPacks: readonly ExtensionPack[] = [
	smwPack,
	bucketPack,
	cargoPack,
	neowikiPack,
];
