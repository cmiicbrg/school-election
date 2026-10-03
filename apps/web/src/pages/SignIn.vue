<script setup lang="ts">
// Where a signed-out person lands: one button, to the school's Microsoft
// sign-in, and back to the page they wanted.

import { computed } from 'vue'
import { useRoute } from 'vue-router'
import { loginUrl } from '../lib/api-rules.ts'

const route = useRoute()
const target = computed(() => loginUrl(typeof route.query.returnTo === 'string' ? route.query.returnTo : '/'))
</script>

<template>
  <h1>Anmeldung</h1>
  <p>Melden Sie sich mit Ihrem Schulkonto an. Zeuginnen und Zeugen melden sich mit dem Konto an, an das die Einladung ging.</p>
  <a
    class="button"
    :href="target"
  >Anmelden</a>
</template>
