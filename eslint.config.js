/**
 * @file eslint.config.js
 * @description ESLint flat config for TypeScript strict mode
 * @version 1.0.0
 * @created 2025-04-11T00:00:00Z
 * @lastUpdated 2025-04-11T00:00:00Z
 */
import eslint from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  eslint.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['src/**/*.ts'],
    languageOptions: {
      parserOptions: {
        projectService: true,
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
  {
    ignores: ['dist/', 'node_modules/'],
  },
);
