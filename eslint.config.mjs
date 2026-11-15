import tseslint from 'typescript-eslint';

export default tseslint.config(
  { ignores: ['.loomery-data/**', '**/node_modules/**', '**/dist/**', '**/out/**'] },
  {
    files: ['**/*.ts', '**/*.tsx'],
    extends: [...tseslint.configs.recommended],
    rules: {
      '@typescript-eslint/no-explicit-any': 'error',
      '@typescript-eslint/consistent-type-imports': 'error',
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
      ],
    },
  },
);
