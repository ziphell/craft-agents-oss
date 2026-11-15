/**
 * ESLint Configuration for UI Package
 *
 * Uses flat config format (ESLint 9+).
 * Enforces use of StyledDropdown wrappers instead of raw Radix primitives.
 */

import tsParser from '@typescript-eslint/parser'
import noHardcodedZIndex from './eslint-rules/no-hardcoded-z-index.cjs'
import noFloatingZTokensInIsland from './eslint-rules/no-floating-z-tokens-in-island.cjs'
import noNonstandardShadows from './eslint-rules/no-nonstandard-shadows.cjs'

export default [
  // Ignore patterns
  {
    ignores: [
      'dist/**',
      'node_modules/**',
    ],
  },

  // TypeScript/React files
  {
    files: ['src/**/*.{ts,tsx}'],
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        ecmaVersion: 'latest',
        sourceType: 'module',
        ecmaFeatures: {
          jsx: true,
        },
      },
    },
    plugins: {
      'craft-styles': {
        rules: {
          'no-hardcoded-z-index': noHardcodedZIndex,
          'no-floating-z-tokens-in-island': noFloatingZTokensInIsland,
          'no-nonstandard-shadows': noNonstandardShadows,
        },
      },
    },
    rules: {
      /**
       * This package runs in **two** places: the desktop renderer (a sandboxed page, no `process`)
       * and the Web UI (a browser tab, no Node at all). A Node global here is not a style choice —
       * it is a `ReferenceError` the first time the component mounts, and it takes the panel down
       * with it: `office-edits.ts` read `process.platform` to compare paths case-insensitively, and
       * opening any document threw `process is not defined` until it was changed to decide from the
       * path itself (`@craft-agent/shared/utils/path-shape`).
       *
       * `process.env` stays allowed on purpose: Vite replaces `process.env.NODE_ENV` at build time,
       * so it is a constant by the time this code runs. `process.platform` never is.
       */
      'no-restricted-properties': ['error',
        { object: 'process', property: 'platform', message: 'No `process` in the renderer or a browser tab. Decide from the value itself (see packages/shared/src/utils/path-shape.ts).' },
        { object: 'process', property: 'cwd', message: 'No `process` in the renderer or a browser tab — the path comes from the platform, not from a working directory.' },
        { object: 'process', property: 'execPath', message: 'No `process` in the renderer or a browser tab.' },
        { object: 'process', property: 'argv', message: 'No `process` in the renderer or a browser tab.' },
      ],
      'no-restricted-globals': ['error',
        { name: 'Buffer', message: 'No `Buffer` in the renderer or a browser tab: use Uint8Array, or read through the platform.' },
        { name: '__dirname', message: 'No Node path globals in the renderer or a browser tab.' },
        { name: 'require', message: 'No CommonJS in the renderer or a browser tab.' },
      ],

      // Prevent direct Radix dropdown imports — use StyledDropdown wrappers instead
      'no-restricted-imports': ['error', {
        paths: [
          {
            name: '@radix-ui/react-dropdown-menu',
            message: 'Use StyledDropdownMenuContent, StyledDropdownMenuItem, etc. from components/ui/StyledDropdown instead.',
          },
        ],
      }],

      // Enforce centralized z-index token scale
      'craft-styles/no-hardcoded-z-index': 'error',

      // Enforce dedicated island z-index tokens in island components
      'craft-styles/no-floating-z-tokens-in-island': 'error',

      // Enforce approved shadow utility classes/tokens only
      'craft-styles/no-nonstandard-shadows': ['error', {
        allowedClasses: [
          'shadow-none',
          'shadow-xs',
          'shadow-minimal',
          'shadow-tinted',
          'shadow-thin',
          'shadow-middle',
          'shadow-strong',
          'shadow-panel-focused',
          'shadow-modal-small',
          'shadow-bottom-border',
          'shadow-bottom-border-thin',
        ],
        allowInlineNone: true,
      }],
    },
  },

  // Temporary exceptions for unresolved shadow migrations.
  {
    files: [
      'src/components/ui/BrowserControls.tsx',
      'src/components/markdown/ImageCardStack.tsx',
      'src/components/ui/__tests__/styled-dropdown.test.ts',
    ],
    rules: {
      'craft-styles/no-nonstandard-shadows': 'off',
    },
  },

  // Allow raw Radix import in the styled wrapper itself
  {
    files: ['src/components/ui/StyledDropdown.tsx'],
    rules: {
      'no-restricted-imports': 'off',
    },
  },

  // Unit tests run in bun, where Node globals exist — the rule is about what ships.
  {
    files: ['src/**/__tests__/**/*.{ts,tsx}'],
    rules: {
      'no-restricted-globals': 'off',
      'no-restricted-properties': 'off',
    },
  }
]
