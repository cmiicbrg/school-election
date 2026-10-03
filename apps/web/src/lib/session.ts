// Who is signed in, for the shell and the pages: loaded once from the
// API, null when nobody is. Signing out ends the session on the server
// and brings the browser to the sign-in page.

import { computed, ref } from 'vue'
import { apiGet, apiPost } from './api.ts'

export interface Me {
  id: string
  displayName: string
  roles: string[]
}

/** undefined until loaded; null when signed out. */
export const session = ref<Me | null | undefined>(undefined)

export const isTeacher = computed(() => session.value?.roles.includes('teacher') ?? false)

export async function loadSession(): Promise<Me | null> {
  session.value = await apiGet<Me>('/api/auth/me', { optional: true })
  return session.value
}

export async function signOut(): Promise<void> {
  await apiPost('/api/auth/logout')
  session.value = null
  window.location.assign('/anmelden')
}
