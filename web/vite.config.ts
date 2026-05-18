import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  // Force a single React instance across pre-bundled deps (eg.
  // @monaco-editor/react was previously pulling in its own copy and
  // crashing with "Cannot read properties of null (reading 'useState')").
  resolve: {
    dedupe: ['react', 'react-dom'],
  },
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
    include: ['react', 'react-dom', 'react-dom/client', '@monaco-editor/react'],
  },
})
