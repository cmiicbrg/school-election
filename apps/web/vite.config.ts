import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'

export default defineConfig({
  plugins: [vue()],
  build: {
    // Every asset is a file under /assets, never a data: URL in the CSS:
    // the content security policy allows fonts from this origin only, and
    // Vite's default inlines the small font subsets, which the browser
    // then refuses and logs on every page.
    assetsInlineLimit: 0,
  },
  server: {
    // The API serves the built app in production; in development Vite
    // forwards /api to a locally running API so the browser sees one origin.
    proxy: {
      '/api': 'http://127.0.0.1:3000',
    },
  },
})
