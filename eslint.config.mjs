import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/.next/**', '**/node_modules/**', 'coverage/**', '**/*.d.ts', '**/*.mjs', '**/*.js', 'apps/web/**'] },
  js.configs.recommended,
  ...tseslint.configs.strictTypeChecked.map(config => ({ ...config, files: ['**/*.ts'] })),
  ...tseslint.configs.stylisticTypeChecked.map(config => ({ ...config, files: ['**/*.ts'] })),
  { files: ['**/*.ts'], languageOptions: { parserOptions: { project: './tsconfig.json', tsconfigRootDir: import.meta.dirname } }, rules: {
    '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' }],
    '@typescript-eslint/no-floating-promises': 'error',
    '@typescript-eslint/no-misused-promises': 'error'
  } },
  { files: ['**/*.test.ts'], rules: { '@typescript-eslint/no-non-null-assertion': 'off' } }
);
