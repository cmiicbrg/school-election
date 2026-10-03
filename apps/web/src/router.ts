// The app's pages by URL (history mode, which the API serves by sending
// index.html for every page path). The print page is the first page with
// an address of its own; the setup screens that lead to it come next.

import { createRouter, createWebHistory } from 'vue-router'
import PrintBatch from './pages/PrintBatch.vue'
import Start from './pages/Start.vue'

export const router = createRouter({
  history: createWebHistory(),
  routes: [
    { path: '/', component: Start },
    { path: '/elections/:id/batches/:batchId/print', component: PrintBatch, props: true },
  ],
})
