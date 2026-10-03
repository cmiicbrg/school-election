<script setup lang="ts">
// The shell: the app's name, who is signed in and "Abmelden", around the
// page. The voter page and the print page stand on their own. Every
// other page is for members: without a session the shell sends the
// browser to the sign-in page, which brings it back here afterwards.

import { computed, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import { isBarePath } from './router.ts'
import { signInUrl } from './lib/api-rules.ts'
import { loadSession, session, signOut } from './lib/session.ts'

const route = useRoute()
const router = useRouter()
const bare = computed(() => isBarePath(route.path))

watch([bare, session, () => route.fullPath], ([isBare, who, path]) => {
  if (isBare) return
  if (who === undefined) {
    void loadSession()
  } else if (who === null && route.path !== '/anmelden') {
    void router.replace(signInUrl(path))
  }
}, { immediate: true })

function onSignOut(): void {
  void signOut()
}
</script>

<template>
  <RouterView v-if="bare" />
  <div
    v-else
    class="shell"
  >
    <header class="shell-header">
      <RouterLink
        to="/"
        class="brand"
      >
        Schulwahl
      </RouterLink>
      <nav
        v-if="session"
        aria-label="Konto"
      >
        <span class="who">{{ session.displayName }}</span>
        <button
          type="button"
          class="link"
          @click="onSignOut"
        >
          Abmelden
        </button>
      </nav>
    </header>
    <main class="shell-main">
      <RouterView />
    </main>
  </div>
</template>
