<script setup lang="ts">
// The shell: the app's name, who is signed in, with their initials, and
// "Abmelden", around the page. The voter page and the print page stand on their own. Every
// other page is for members: it is shown once someone is signed in, so
// no page asks the API without a session, and without one the shell
// sends the browser to the sign-in page, which brings it back here
// afterwards. The sign-in page itself is shown once the session is known.

import { computed, watch } from 'vue'
import { RouterLink, RouterView, useRoute, useRouter } from 'vue-router'
import LineIcon from './components/LineIcon.vue'
import ToastRegion from './components/ToastRegion.vue'
import { isBarePath } from './router.ts'
import { signInUrl } from './lib/api-rules.ts'
import { withBase } from './lib/base.ts'
import { initials } from './lib/people.ts'
import { loadSession, session, signOut } from './lib/session.ts'

const route = useRoute()
const router = useRouter()
const bare = computed(() => isBarePath(route.path))
/** A page of cards, such as the termin: wider, on a grey ground. */
const wide = computed(() => route.meta.wide === true)
const shown = computed(() => session.value !== undefined && (session.value !== null || route.path === '/anmelden'))

watch([bare, session, () => route.fullPath], ([isBare, who, path]) => {
  if (isBare) return
  if (who === undefined) {
    void loadSession()
  } else if (who === null && route.path !== '/anmelden') {
    void router.replace(signInUrl(withBase(path)))
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
    :class="['shell', { wide }]"
  >
    <header class="shell-header">
      <div class="shell-bar">
        <RouterLink
          to="/"
          class="brand"
        >
          <span class="brand-mark"><LineIcon
            name="ballot"
            :size="18"
          /></span>
          Schulwahl
        </RouterLink>
        <nav
          v-if="session"
          aria-label="Konto"
        >
          <span
            v-if="initials(session.displayName)"
            class="initials"
            aria-hidden="true"
          >{{ initials(session.displayName) }}</span>
          <span class="who">{{ session.displayName }}</span>
          <button
            type="button"
            class="ghost sign-out"
            @click="onSignOut"
          >
            Abmelden
          </button>
        </nav>
      </div>
    </header>
    <main class="shell-main">
      <RouterView v-if="shown" />
    </main>
    <ToastRegion />
  </div>
</template>
