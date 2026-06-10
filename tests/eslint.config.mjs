import rootConfig from '../eslint.config.mjs';

export default [
  {
    ignores: [
      '*.mjs',
      '**/*/*.mjs',
      'reports/report/**',
    ]
  },
  ...rootConfig.map(config => ({
    ...config,
    files: [
      "src/**/**/*.ts"
    ]
  })),
  {
    rules: {
      '@typescript-eslint/explicit-function-return-type': 'off',
      '@typescript-eslint/no-misused-promises': 'off', // https://github.com/typescript-eslint/typescript-eslint/issues/5807
      '@typescript-eslint/promise-function-async': 'off',
      '@typescript-eslint/no-redeclare': 'off',
      '@typescript-eslint/no-unsafe-argument': 'off',
      'no-console': 'off', // E2E tests will require writing to the console.
      'brace-style': [ 'error', '1tbs' ],
    }
  }
];
