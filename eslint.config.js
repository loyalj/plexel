// Lint: the mistakes the type checker doesn't catch, not style (the code's style is consistent, and
// .editorconfig keeps it so). Part of check:static (scripts/run-checks.mjs).
//
// - Promises nobody waits for or catches, and async functions where a plain one is expected: a failure
//   there vanishes, or a handler returns before its work is done.
// - The rules of hooks.
// - Type-only imports marked as such, so the dependency check (.dependency-cruiser.cjs) sees which
//   imports are only types and leaves them out of the cycles it looks for.
//
// exhaustive-deps is left off: dependency lists are chosen on purpose in places (a signature string, a
// value read through a ref), and say so where they are.
import tseslint from 'typescript-eslint'
import reactHooks from 'eslint-plugin-react-hooks'

export default tseslint.config(
  { ignores: ['dist/**', 'node_modules/**', 'src/**/wasm/**', 'scripts/fixtures/**', 'native/**', 'public/**'] },
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tseslint.parser,
      parserOptions: { projectService: true, tsconfigRootDir: import.meta.dirname },
    },
    plugins: { '@typescript-eslint': tseslint.plugin, 'react-hooks': reactHooks },
    rules: {
      '@typescript-eslint/no-floating-promises': 'error',
      // Not for JSX attributes: React ignores what a handler returns, and async handlers are how a file
      // input or a button that loads something is written here.
      '@typescript-eslint/no-misused-promises': ['error', { checksVoidReturn: { attributes: false } }],
      '@typescript-eslint/consistent-type-imports': ['error', { fixStyle: 'inline-type-imports' }],
      'react-hooks/rules-of-hooks': 'error',
    },
  },
)
