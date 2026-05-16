import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    fs: {
      // Allow reading the wasm artifact next to the source tree.
      allow: ['..'],
    },
  },
  // Treat .wasm as an asset Vite handles via fetch().
  assetsInclude: ['**/*.wasm'],
  optimizeDeps: {
    exclude: ['./src/wasm/ecto_engine.js'],
  },
})
