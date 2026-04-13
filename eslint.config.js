import { FlatCompat } from '@eslint/eslintrc';
import js from '@eslint/js';
import tsParser from '@typescript-eslint/parser';
import { fileURLToPath } from 'url';
import path from 'path';

const __filename = fileURLToPath( import.meta.url );
const __dirname = path.dirname( __filename );

const compat = new FlatCompat( {
	baseDirectory: __dirname,
	recommendedConfig: js.configs.recommended,
} );

export default [
	{
		ignores: [ 'i18n/**', 'node_modules/**', 'dist/**', 'build/**' ],
	},
	...compat.extends( 'wikimedia', 'wikimedia/node', 'wikimedia/language/es2022' ),
	{
		files: [ '**/*.ts' ],
		languageOptions: {
			parser: tsParser,
		},
	},
	{
		rules: {
			'comma-dangle': 'off',
			'no-shadow': 'off',
			'es-x/no-hashbang': 'off',
		},
	},
	{
		files: [ 'scripts/**' ],
		rules: {
			'security/detect-non-literal-fs-filename': 'off',
		},
	},
];
