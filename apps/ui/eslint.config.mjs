import rootConfig from "../../eslint.config.mjs";

export default [
  {
    ignores: [
      '*.mjs',
      "dist/**",
      "coverage/**",
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
