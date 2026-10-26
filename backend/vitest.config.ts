import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // The tests share one database and one engine per file, so run files one at a time.
    fileParallelism: false,
    testTimeout: 15_000,
    hookTimeout: 30_000,
  },
});
