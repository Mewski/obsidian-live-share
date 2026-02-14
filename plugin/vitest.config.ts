import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    deps: {
      inline: [],
    },
  },
  resolve: {
    alias: {
      obsidian: new URL("./src/__mocks__/obsidian.ts", import.meta.url).pathname,
    },
  },
});
