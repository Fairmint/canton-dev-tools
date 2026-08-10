import typescriptEslintPlugin from '@typescript-eslint/eslint-plugin';
import typescriptEslintParser from '@typescript-eslint/parser';
import unusedImportsPlugin from 'eslint-plugin-unused-imports';

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', '**/coverage/**', '**/scripts/**', 'bin/**'],
  },
  {
    files: ['**/*.ts'],
    languageOptions: {
      parser: typescriptEslintParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
      },
    },
    plugins: {
      '@typescript-eslint': typescriptEslintPlugin,
      'unused-imports': unusedImportsPlugin,
    },
    rules: {
      'unused-imports/no-unused-imports': 'warn',
      'unused-imports/no-unused-vars': [
        'warn',
        {
          vars: 'all',
          varsIgnorePattern: '^_',
          args: 'after-used',
          argsIgnorePattern: '^_',
          caughtErrors: 'all',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      'no-unused-vars': 'off',
      '@typescript-eslint/no-unused-vars': 'off',
      '@typescript-eslint/no-explicit-any': 'warn',
    },
  },
];
