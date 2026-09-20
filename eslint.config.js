import js from '@eslint/js';
import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['**/dist/**', '**/node_modules/**', '**/.next/**', '**/migrations/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        // eslint.config.js is not part of the TS project; allow it its own default.
        projectService: { allowDefaultProject: ['eslint.config.js'] },
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_', varsIgnorePattern: '^_' }],
      '@typescript-eslint/no-floating-promises': 'error',
      '@typescript-eslint/no-misused-promises': 'error',
      // Raw SQL is the point of this codebase (ADR-014); template strings carrying
      // SQL must never be flagged as "unnecessary".
      '@typescript-eslint/restrict-template-expressions': 'off',
    },
  },
  {
    files: ['**/*.config.ts', '**/*.config.js', 'packages/testkit/**/*.ts'],
    rules: { '@typescript-eslint/no-floating-promises': 'off' },
  },
  {
    // Tests read loosely-typed JSON straight off the wire, which is the point:
    // asserting against the real response shape rather than a convenient type.
    files: ['**/test/**/*.ts'],
    rules: { '@typescript-eslint/no-explicit-any': 'off', '@typescript-eslint/no-unsafe-member-access': 'off' },
  },
);
