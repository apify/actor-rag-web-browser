import { defineConfig } from 'vitest/config';

export default defineConfig({
    test: {
        // Generous timeout because most of the tests launch a browser, which is slow on a cold start
        testTimeout: 30000,
        globals: true,
        environment: 'node',
        include: ['tests/**/*.test.ts'],
        exclude: [
            '**/helpers/**',
            '**/node_modules/**',
            'tests/helpers/server.ts', // Explicitly ignore the server helper
        ],
    },
});
