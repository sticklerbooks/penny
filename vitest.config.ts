import { defineConfig } from 'vitest/config'
import { fileURLToPath } from 'node:url'

// Resolve the project's "@/..." path alias in tests (matches tsconfig paths).
// Pure modules import fine; anything pulling @/lib/db still must not be imported
// from a test (it constructs the Turso client at module load).
export default defineConfig({
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
})
