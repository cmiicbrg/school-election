// First of all, before the router exists: on the voter page the key leaves
// the fragment and the history entry (voter/bootstrap.ts).
import './voter/take-key.ts'
import { createApp } from 'vue'
import App from './App.vue'
import { onUnauthenticated } from './lib/api.ts'
import { signInUrl } from './lib/api-rules.ts'
import { session } from './lib/session.ts'
import { router } from './router.ts'
import './styles.css'

// A 401 sends the browser to sign-in and back to this page afterwards. The
// session the page knew about is gone, so the sign-in page does not send
// a person it takes for signed in straight back. A page's requests fail
// together: the first one takes the browser there, the others find it on
// the sign-in page already and leave the return path alone.
onUnauthenticated(() => {
  session.value = null
  const route = router.currentRoute.value
  if (route.path !== '/anmelden') void router.replace(signInUrl(route.fullPath))
})

createApp(App).use(router).mount('#app')
