import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    coverage: {
      provider: "v8",
      reporter: ["text", "json-summary"]
    },
    globals: false,
    // The CLI and runner integration tests take about 1.7 s each on a
    // 2-core CI runner. A slow runner can take 3 times longer, so the
    // 5 s default is not sufficient.
    testTimeout: 15_000,
    include: [
      "packages/**/*.test.ts",
      "apps/**/*.test.ts",
      "tests/**/*.test.ts"
    ]
  }
});
