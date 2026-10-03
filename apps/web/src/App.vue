<script setup lang="ts">
// The shell: the app's name, who is signed in and "Abmelden", around the
// page. The voter page and the print page stand on their own.

import { computed, watch } from 'vue'
import { RouterLink, RouterView, useRoute } from 'vue-router'
import { isBarePath } from './router.ts'
import { loadSession, session, signOut } from './lib/session.ts'

const route = useRoute()
const bare = computed(() => isBarePath(route.path))

watch(bare, (isBare) => {
  if (!isBare && session.value === undefined) void loadSession()
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
