import type { ExtensionPack } from './types.js';
import { smwPack } from './smw/index.js';
import { bucketPack } from './bucket/index.js';
import { cargoPack } from './cargo/index.js';

export type { ExtensionPack } from './types.js';
export const extensionPacks: readonly ExtensionPack[] = [smwPack, bucketPack, cargoPack];
