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
  })),
  {
    files: ["src/WalletFactory.ts"],
    rules: {
      "@typescript-eslint/no-unsafe-argument": "off",
      "@typescript-eslint/no-unsafe-assignment": "off",
      "@typescript-eslint/no-unsafe-return": "off",
    }
  }
];
