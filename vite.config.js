import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import threadline from '@threadline/vite-plugin'

// No explicit dbPath — the plugin derives one per workspace (threadline.db
// inside the selected workspace root), so each project keeps its own user
// registry and comment-thread index.

export default defineConfig({
  // No defaultRoot: the workspace folder is chosen at runtime (see
  // App.jsx / electron/main.cjs's directory picker) and sent per-request via
  // the x-threadline-root header.
  plugins: [react(), tailwindcss(), threadline()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  server: {
    port: 5173,
    open: true
  }
})
