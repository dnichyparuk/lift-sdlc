'use strict';

// Flat config for ESLint 10+ (replaces the legacy scripts/.eslintrc.json,
// which ESLint 10 no longer loads automatically). Mirrors the previous
// config's rule set exactly: `env: {node, es2021}` + `eslint:recommended`
// + the three explicit rule overrides.
const js = require('@eslint/js');
const globals = require('globals');

module.exports = [
  js.configs.recommended,
  {
    files: ['scripts/**/*.js', 'scripts/**/*.cjs', 'skills/**/*.js', 'skills/**/*.cjs'],
    languageOptions: {
      ecmaVersion: 2021,
      sourceType: 'commonjs',
      globals: {
        ...globals.node,
      },
    },
    rules: {
      'no-undef': 'error',
      'no-unused-vars': 'off',
      'no-redeclare': 'error',
      // `no-useless-assignment` and `preserve-caught-error` were added to
      // `eslint:recommended` after the pre-migration ESLint 8.57.1 baseline.
      // Both are legitimate rules (~20 dead-store / missing-`cause` findings
      // across ~10 files) but fixing them is out of scope for this dependency
      // upgrade — disabled here to keep this change a pure version bump with
      // no behavioral lint-surface change. Re-enabling and clearing the
      // findings is a good follow-up.
      'no-useless-assignment': 'off',
      'preserve-caught-error': 'off',
    },
  },
];
