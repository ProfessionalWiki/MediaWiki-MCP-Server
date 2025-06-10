import { createRequire } from 'node:module';

type PackageJSON = {
	name: string;
	version: string;
	description: string;
};

// https://github.com/nodejs/node/issues/51347#issuecomment-2111337854
export const packageJSON = createRequire( import.meta.url )( '../package.json' ) as PackageJSON;
