import js from '@eslint/js'
import tseslint from 'typescript-eslint'
import globals from 'globals'

// Time must be injectable (Clock / app_now()). Bare Date.now(), new Date() and Math.random() are banned
// everywhere except the platform time/clock/random modules.
const timeBans = {
  'no-restricted-properties': [
    'error',
    { object: 'Date', property: 'now', message: 'Use the injected Clock (src/platform/clock.ts).' },
    { object: 'Math', property: 'random', message: 'Use src/platform/random.ts (seedable).' },
    { object: 'DateTime', property: 'now', message: 'Luxon DateTime.now() reads the wall clock; use the injected Clock.' },
    { object: 'Settings', property: 'now', message: 'Do not override the Luxon clock; inject a Clock instead.' },
  ],
  'no-restricted-syntax': [
    'error',
    {
      selector: "NewExpression[callee.name='Date'][arguments.length=0]",
      message: 'new Date() with no arguments reads the wall clock; use the injected Clock.',
    },
    {
      selector: "CallExpression[callee.name='Date']",
      message: 'Date() reads the wall clock; use the injected Clock.',
    },
    {
      selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='local'][arguments.length=0]",
      message: 'DateTime.local() with no arguments reads the wall clock; use the injected Clock.',
    },
    {
      selector: "CallExpression[callee.object.name='DateTime'][callee.property.name='utc'][arguments.length=0]",
      message: 'DateTime.utc() with no arguments reads the wall clock; use the injected Clock.',
    },
  ],
}

export default tseslint.config(
  { ignores: ['node_modules', 'dist', 'coverage', 'docs'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    languageOptions: { globals: { ...globals.node } },
    rules: { '@typescript-eslint/no-unused-vars': ['error', { argsIgnorePattern: '^_' }], ...timeBans },
  },
  {
    files: ['src/platform/clock.ts', 'src/platform/time.ts', 'src/platform/random.ts', 'test/**/*.ts', 'scripts/**/*.ts'],
    rules: { 'no-restricted-properties': 'off', 'no-restricted-syntax': 'off' },
  },
)
