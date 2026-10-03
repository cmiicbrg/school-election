import { createApp } from 'vue'
import App from './App.vue'
import { onUnauthenticated } from './lib/api.ts'
import { router } from './router.ts'
import './styles.css'

onUnauthenticated((url) => {
  void router.replace(url)
})

createApp(App).use(router).mount('#app')
