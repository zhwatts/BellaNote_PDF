import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  build: {
    outDir: '../static',
    emptyOutDir: true,
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
