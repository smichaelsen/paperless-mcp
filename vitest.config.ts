import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    // Integration tests talk to a real Paperless instance and are opt-in via
    // PAPERLESS_TEST_URL; they skip themselves when it is unset.
    testTimeout: 20000,
  },
});
