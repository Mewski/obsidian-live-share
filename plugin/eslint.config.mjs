import tsParser from "@typescript-eslint/parser";
import obsidianPlugin from "eslint-plugin-obsidianmd";

export default [
  {
    files: ["src/**/*.ts"],
    ignores: ["src/__tests__/**", "src/__mocks__/**"],
    plugins: {
      obsidianmd: obsidianPlugin,
    },
    languageOptions: {
      parser: tsParser,
      parserOptions: {
        project: "./tsconfig.json",
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      ...obsidianPlugin.configs.recommended,
      "obsidianmd/ui/sentence-case": ["warn", { brands: ["Live Share", "Obsidian"] }],
    },
  },
];
