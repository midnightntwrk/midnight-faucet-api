import rootConfig from "../../eslint.config.mjs";

export default [
  {
    ignores: [
      '*.mjs',
      "dist/**",
      "coverage/**",
      ".vitest/**",
      "reports/**",
    ]
  },
  ...rootConfig.map(config => ({
    ...config,
    files: [
      "src/**/*.ts",
      "test/**/*.ts"
    ]
  }))
];
