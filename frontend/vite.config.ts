import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  // Vite 8 defaults to LightningCSS, whose optional native addon is often missing on
  // Linux CI (e.g. Render) with npm workspaces. PostCSS + esbuild avoids that.
  css: {
    transformer: 'postcss',
  },
  build: {
    outDir: '../static',
    emptyOutDir: true,
    cssMinify: 'esbuild',
  },
  server: {
    port: 5173,
    proxy: {
      '/upload': 'http://127.0.0.1:8000',
      '/documents': 'http://127.0.0.1:8000',
      '/slides': 'http://127.0.0.1:8000',
      '/highlights': 'http://127.0.0.1:8000',
      '/export': 'http://127.0.0.1:8000',
    },
  },
})
