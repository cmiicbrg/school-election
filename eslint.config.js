import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import pluginVue from 'eslint-plugin-vue'
import vueParser from 'vue-eslint-parser'
import stylistic from '@stylistic/eslint-plugin'
import globals from 'globals'

const jsFiles = ['**/*.{js,mjs,cjs}']
const tsFiles = ['**/*.ts']
const vueFiles = ['**/*.vue']
const typedFiles = [...tsFiles, ...vueFiles]

export default [
  {
    ignores: ['**/node_modules/**', '**/dist/**', 'coverage/**', 'tmp/**'],
  },

  // One formatter for the whole repository, enforced by ESLint rather than a
  // separate Prettier pass: two spaces, single quotes, no semicolons,
  // trailing commas on multi-line literals.
  stylistic.configs.customize({
    indent: 2,
    quotes: 'single',
    semi: false,
    jsx: false,
    commaDangle: 'always-multiline',
    braceStyle: '1tbs',
    arrowParens: true,
  }),

  // Plain JS: this config file and the repository scripts.
  {
    ...js.configs.recommended,
    files: jsFiles,
  },
  {
    files: jsFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      globals: { ...globals.node },
    },
    rules: {
      'no-unused-vars': ['error', { argsIgnorePattern: '^_' }],
    },
  },

  // TypeScript and Vue SFCs — recommendedTypeChecked, not plain recommended.
  // The rules that matter most here are not type errors: `tsc` never reports
  // a floating promise or a promise handed to a void callback, and in this
  // application an unawaited query inside the ballot transaction is a vote
  // that is acknowledged without being stored.
  ...tseslint.configs.recommendedTypeChecked.map((c) => ({ ...c, files: typedFiles })),
  ...pluginVue.configs['flat/recommended'].map((c) => ({ ...c, files: vueFiles })),
  {
    files: typedFiles,
    languageOptions: {
      ecmaVersion: 'latest',
      sourceType: 'module',
      parserOptions: {
        // Each workspace has its own tsconfig.json; the project service picks
        // the nearest one per file. vite.config.ts and the Playwright config
        // at the root are the files no tsconfig.json beside them includes
        // (both run in Node), so they get the web workspace's Node-side
        // config as their default.
        projectService: {
          allowDefaultProject: ['apps/web/vite.config.ts', 'playwright.config.ts'],
          defaultProject: 'apps/web/tsconfig.node.json',
        },
        tsconfigRootDir: import.meta.dirname,
        extraFileExtensions: ['.vue'],
      },
    },
    rules: {
      // Leading underscores mark intentionally-unused bindings.
      '@typescript-eslint/no-unused-vars': ['error', {
        argsIgnorePattern: '^_',
        varsIgnorePattern: '^_',
        caughtErrorsIgnorePattern: '^_',
      }],

      // node:test's `test()` returns a promise the runner itself awaits, so
      // every top-level call is "floating" by design. Whitelisting the runner
      // entry points keeps the rule live inside test bodies.
      '@typescript-eslint/no-floating-promises': ['error', {
        allowForKnownSafeCalls: [
          {
            from: 'package',
            package: 'node:test',
            name: ['test', 'it', 'describe', 'suite', 'before', 'after', 'beforeEach', 'afterEach'],
          },
        ],
      }],

      // Fastify's plugin and hook contracts require async functions even when
      // there is nothing to await; the rule is a style hint, not correctness.
      '@typescript-eslint/require-await': 'off',
    },
  },
  {
    files: vueFiles,
    languageOptions: {
      parser: vueParser,
      parserOptions: {
        parser: tseslint.parser,
      },
    },
    rules: {
      'vue/multi-word-component-names': 'off',
      // Ballot and candidate text is user-entered; render it as text only.
      'vue/no-v-html': 'error',
    },
  },

  // The tally and ballot-validation code is a pure domain module: it must not
  // depend on HTTP, PostgreSQL, sessions, Vue or Node APIs, so the same code
  // runs in the API, the browser and an offline verifier. It must also be
  // deterministic: the same configuration and ballots always give the same
  // result, so nothing in it may read randomness or the clock. Enforced here
  // rather than left to review. Tests may use node:test.
  {
    files: ['packages/election-core/src/**/*.ts'],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            // Only same-directory imports: src is flat, so any ../ would
            // leave it. Widen this deliberately if src ever gets folders.
            regex: String.raw`^(?!\./)`,
            message: 'election-core is a pure domain module: only ./ imports inside src are allowed.',
          },
        ],
      }],
      // The global-object aliases are banned outright, because through them
      // every other restriction could be sidestepped (globalThis.Math.random),
      // and process because Node's types are in scope for the tests.
      'no-restricted-globals': ['error',
        { name: 'Date', message: 'election-core must not depend on the clock.' },
        { name: 'crypto', message: 'election-core must not depend on randomness.' },
        { name: 'performance', message: 'election-core must not depend on the clock.' },
        ...['globalThis', 'global', 'window', 'self', 'process'].map((name) => ({
          name,
          message: 'election-core must not reach the runtime environment.',
        })),
      ],
      'no-restricted-properties': ['error',
        { object: 'Math', property: 'random', message: 'election-core must not depend on randomness.' },
      ],
    },
  },

  // Canonical JSON, the audit hash chain, the count's digest, the export's
  // shape and the verifier are what the offline verifier runs on, so they
  // stay pure: election-core, node:crypto and each other, no database, no
  // network, no file system, no environment.
  {
    files: [
      'apps/api/lib/canonical-json.ts',
      'apps/api/lib/audit-chain.ts',
      'apps/api/lib/tally-digest.ts',
      'apps/api/lib/export-format.ts',
      'apps/api/lib/export-verify.ts',
    ],
    rules: {
      'no-restricted-imports': ['error', {
        patterns: [
          {
            regex: String.raw`^(?!node:crypto$|@school-election/election-core$|\./(canonical-json|audit-chain|tally-digest|export-format)\.ts$)`,
            message: 'The export is verified offline: import only node:crypto, election-core and the pure modules beside this one.',
          },
        ],
      }],
      'no-restricted-globals': ['error',
        ...['process', 'fetch', 'globalThis', 'global'].map((name) => ({
          name,
          message: 'The export is verified offline: no access to the runtime environment.',
        })),
      ],
    },
  },
]
