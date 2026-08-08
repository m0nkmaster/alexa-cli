import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["test/**/*.test.ts"],
    exclude: process.env.TEST_INTEGRATION ? [] : ["test/integration/**"],
  },
});
