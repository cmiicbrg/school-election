import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  server: {
    // The API serves the built app in production; in development Vite
    // forwards /api to a locally running API so the browser sees one origin.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
