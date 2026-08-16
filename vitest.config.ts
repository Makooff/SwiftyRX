import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Tests must never touch the network. Adapters are exercised against
    // recorded fixtures injected through the HttpClient `fetchImpl` seam.
    testTimeout: 10_000,
  },
});
