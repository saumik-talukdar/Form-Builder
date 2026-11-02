import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["src/integration/**/*.test.ts"],
    fileParallelism: false,
    env: {
      JWT_SECRET: "test-secret-1234567890",
      IP_HASH_SECRET: "test-hash-secret-123456",
    },
  },
});
