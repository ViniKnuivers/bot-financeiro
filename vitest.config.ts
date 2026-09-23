import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
    // Desfaz vi.stubEnv / mocks entre testes, para um teste não vazar estado no outro.
    unstubEnvs: true,
    restoreMocks: true,
  },
});
