// The app's pages by URL (history mode, which the API serves by sending
// index.html for every page path). The pages people see have German
// paths; the print page keeps its address, which cards and links carry,
// and the voter page is at /v, which every card points to (the key in the
// fragment, taken before this router exists: voter/take-key.ts). All of
// it under the app's base path (lib/base.ts), which the router adds and
// takes off, so route paths here and in the pages never carry it.

import { createRouter, createWebHistory } from 'vue-router'
import { BASE_PATH } from './lib/base.ts'
import AuditLog from './pages/AuditLog.vue'
import ElectionDayHelp from './pages/ElectionDayHelp.vue'
import ElectionList from './pages/ElectionList.vue'
import ElectionPage from './pages/ElectionPage.vue'
import NewElection from './pages/NewElection.vue'
import PrintBatch from './pages/PrintBatch.vue'
import Results from './pages/Results.vue'
import SignIn from './pages/SignIn.vue'
import Voter from './pages/Voter.vue'

export const router = createRouter({
  history: createWebHistory(`${BASE_PATH}/`),
  routes: [
    { path: '/', component: ElectionList },
    { path: '/anmelden', component: SignIn },
    { path: '/wahlen/neu', component: NewElection },
    { path: '/wahlen/:id', component: ElectionPage, props: true, meta: { wide: true } },
    { path: '/wahlen/:id/ergebnis', component: Results, props: true },
    { path: '/wahlen/:id/protokoll', component: AuditLog, props: true },
    { path: '/hilfe/wahltag', component: ElectionDayHelp },
    { path: '/v', component: Voter },
    { path: '/elections/:id/batches/:batchId/print', component: PrintBatch, props: true },
  ],
})

/** Pages without the shell: the voter page and the print page. */
export function isBarePath(path: string): boolean {
  return path === '/v' || path.endsWith('/print')
}
