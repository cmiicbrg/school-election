<script setup lang="ts">
// Where a signed-out person lands: one button, to the school's Microsoft
// sign-in, and back to the page they wanted. Whoever is signed in already
// is sent there right away. The return path is a full path, base path
// included, as the server takes it; the router gets it without the base.

import { computed, watch } from 'vue'
import { useRoute, useRouter } from 'vue-router'
import { loginUrl, ownPath } from '../lib/api-rules.ts'
import { withBase, withoutBase } from '../lib/base.ts'
import { usePageTitle } from '../lib/page-title.ts'
import { session } from '../lib/session.ts'

const route = useRoute()
const router = useRouter()
usePageTitle(() => 'Anmeldung')
const returnTo = computed(() => ownPath(typeof route.query.returnTo === 'string' ? route.query.returnTo : withBase('/')))
const target = computed(() => withBase(loginUrl(returnTo.value)))

watch([session, returnTo], ([who, to]) => {
  if (who) void router.replace(withoutBase(to))
}, { immediate: true })
</script>

<template>
  <h1>Anmeldung</h1>
  <p>Melden Sie sich mit Ihrem Schulkonto an. Zeug:innen melden sich mit dem Konto an, an das die Einladung ging.</p>
  <a
    class="button"
    :href="target"
  >Anmelden</a>
</template>
