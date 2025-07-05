import tsParser from '@typescript-eslint/parser';
import tsPlugin from '@typescript-eslint/eslint-plugin';
import fpPlugin from 'eslint-plugin-fp';
import functionalPlugin from 'eslint-plugin-functional';

export default [
	{
		files: ['**/*.ts'],
		languageOptions: {
			parser: tsParser,
			parserOptions: {
				project: './tsconfig.json',
				ecmaVersion: 2022,
				sourceType: 'module',
			},
		},
		plugins: {
			'@typescript-eslint': tsPlugin,
			fp: fpPlugin,
			functional: functionalPlugin,
		},
		rules: {
			// TypeScript recommended rules
			...tsPlugin.configs['recommended'].rules,
			...tsPlugin.configs['recommended-requiring-type-checking'].rules,

			// Functional programming rules
			'functional/immutable-data': 'error',
			'functional/no-classes': 'error',
			'functional/no-let': 'error',
			'functional/no-loop-statements': 'error',
			'functional/no-throw-statements': 'error',
			'functional/prefer-immutable-types': 'off', // Too strict for MVP
			'functional/functional-parameters': 'off', // Allow flexibility in parameter count

			// FP plugin rules
			'fp/no-mutation': 'error',
			'fp/no-mutating-methods': 'error',
			'fp/no-delete': 'error',
			'fp/no-let': 'error',
			'fp/no-loops': 'error',
			'fp/no-class': 'error',
			'fp/no-this': 'error',
			'fp/no-throw': 'error',
			'fp/no-nil': 'off', // Allow null/undefined
			'fp/no-unused-expression': 'off', // Conflicts with TS

			// Disable some conflicting rules
			'@typescript-eslint/no-explicit-any': 'off', // Used in some type tricks
			'@typescript-eslint/no-non-null-assertion': 'off', // Sometimes necessary

			// Async/await best practices
			'@typescript-eslint/no-floating-promises': 'error',
			'@typescript-eslint/no-misused-promises': 'error',
			'@typescript-eslint/await-thenable': 'error',
			'@typescript-eslint/require-await': 'error',

			// Enforce exhaustive checks
			'@typescript-eslint/switch-exhaustiveness-check': 'error',
		},
	},
	{
		ignores: ['node_modules/', 'dist/', '*.config.js', '*.config.mjs', 'bun.lockb'],
	},
];
