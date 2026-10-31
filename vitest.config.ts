import { defineConfig } from "vitest/config";

// One test run for the whole repo: server logic and pure web helpers.
// Tests live next to the file they test, named *.test.ts.
export default defineConfig({
  test: {
    include: ["server/**/*.test.ts", "web/src/**/*.test.ts"],
    environment: "node",
    testTimeout: 10_000,
  },
});
