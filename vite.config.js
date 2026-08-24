import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import threadline from '@threadline/vite-plugin'

// The one shared SQLite file, a sibling of this project. It holds the user
// registry (written by electron/main.cjs on first sight of a git identity —
// keep this path in step with its USER_DB_PATH) and the derived comment-thread
// index the panel's repo-wide lists read from. Story content is never in here:
// that lives in the workspace's markdown files.
const DB_PATH = fileURLToPath(new URL('../threadline.db', import.meta.url))

export default defineConfig({
  // No defaultRoot: the workspace folder is chosen at runtime (see
  // App.jsx / electron/main.cjs's directory picker) and sent per-request via
  // the x-threadline-root header.
  plugins: [react(), tailwindcss(), threadline({ dbPath: DB_PATH })],
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
