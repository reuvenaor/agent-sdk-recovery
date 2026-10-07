import js from '@eslint/js'
import prettier from 'eslint-config-prettier'
import { defineConfig } from 'eslint/config'
import globals from 'globals'
import tseslint from 'typescript-eslint'

const NO_AGENT_SDK = {
  name: '@anthropic-ai/claude-agent-sdk',
  message: 'agent-sdk-recovery must not import @anthropic-ai/claude-agent-sdk.',
}
const NO_ZOD = {
  name: 'zod',
  message: 'agent-sdk-recovery takes any Standard Schema; its src/ must not import zod.',
}

/**
 * Rules that fail an import of each banned module: static imports (type-only ones too) through
 * no-restricted-imports, `import()` calls and `import('…')` types through two selectors.
 */
function bannedImports(bans) {
  const pattern = (name) => `/^${name.replaceAll('/', '\\/')}(\\/|$)/`
  return {
    'no-restricted-imports': [
      'error',
      {
        paths: bans.map(({ name, message }) => ({ name, message })),
        patterns: bans.map(({ name, message }) => ({ group: [`${name}/*`], message })),
      },
    ],
    'no-restricted-syntax': [
      'error',
      ...bans.flatMap(({ name, message }) => [
        { selector: `ImportExpression[source.value=${pattern(name)}]`, message },
        { selector: `TSImportType[argument.literal.value=${pattern(name)}]`, message },
      ]),
    ],
  }
}

export default defineConfig(
  { ignores: ['dist'] },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    languageOptions: { globals: globals.node },
    rules: {
      '@typescript-eslint/no-unused-vars': [
        'error',
        { argsIgnorePattern: '^_', varsIgnorePattern: '^_', caughtErrorsIgnorePattern: '^_' },
      ],
    },
  },
  // The SDK and zod are devDependencies (the README check and the tests use them), so an
  // import of either would still compile. The package itself depends on neither.
  { files: ['**/*.ts'], rules: bannedImports([NO_AGENT_SDK]) },
  { files: ['src/**/*.ts'], rules: bannedImports([NO_AGENT_SDK, NO_ZOD]) },
  prettier,
)
