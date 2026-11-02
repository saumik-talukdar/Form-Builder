import { configDefaults, defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    // config.ts validates env at import time; give tests safe values.
    env: {
      JWT_SECRET: "test-secret-1234567890",
      IP_HASH_SECRET: "test-hash-secret-123456",
    },
    // Integration tests need a real database; run them with `npm run test:integration`.
    exclude: [...configDefaults.exclude, "src/integration/**"],
  },
});
