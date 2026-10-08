<script setup lang="ts">
// Mitglieder: co-admins and witnesses, pending or bound, invited by their
// school e-mail address. An invitation takes effect at the invited
// person's next sign-in, which the page says after inviting. Removing a
// member asks first, in place, and a toast confirms it.

import { nextTick, ref, useId } from 'vue'
import { apiDelete, apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { MEMBER_STATUS_LABELS, ROLE_LABELS } from '../lib/labels.ts'
import { notify } from '../lib/toast.ts'
import type { Member } from '../lib/types.ts'

const props = defineProps<{
  electionId: string
  members: Member[]
  /** The caller may invite and remove. */
  manage: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const ids = { email: useId(), role: useId() }
const email = ref('')
const role = ref<'admin' | 'witness'>('witness')
const busy = ref(false)
const error = ref<string | null>(null)
const hint = ref<string | null>(null)
/** The member whose removal waits for its confirmation. */
const confirming = ref<string | null>(null)

async function invite(): Promise<void> {
  busy.value = true
  error.value = null
  hint.value = null
  try {
    const member = await apiPost<Member>(`/api/elections/${props.electionId}/members`, { email: email.value, role: role.value })
    hint.value = `Die Einladung an ${member.email ?? email.value} gilt ab der nächsten Anmeldung dieser Person. Wer gerade angemeldet ist, muss sich ab- und wieder anmelden.`
    email.value = ''
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

async function ask(member: Member): Promise<void> {
  confirming.value = member.id
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-confirm="${CSS.escape(member.id)}"] .cancel`)?.focus()
}
async function cancel(): Promise<void> {
  const id = confirming.value
  confirming.value = null
  if (id === null) return
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-remove="${CSS.escape(id)}"]`)?.focus()
}
async function remove(member: Member): Promise<void> {
  confirming.value = null
  busy.value = true
  error.value = null
  hint.value = null
  try {
    await apiDelete(`/api/elections/${props.electionId}/members/${member.id}`)
    notify(`${nameOf(member)} (${ROLE_LABELS[member.role]}) entfernt.`)
    emit('changed')
  } catch (err) {
    error.value = errorMessage(err)
  } finally {
    busy.value = false
  }
}

function nameOf(member: Member): string {
  return member.displayName ?? member.email ?? ''
}
</script>

<template>
  <section aria-labelledby="members-heading">
    <h2 id="members-heading">
      Mitglieder
    </h2>
    <ul
      class="plain"
      aria-label="Mitglieder"
    >
      <li
        v-for="member in members"
        :key="member.id"
        class="row"
      >
        <span>
          <strong>{{ nameOf(member) }}</strong>
          <span class="muted"> · {{ ROLE_LABELS[member.role] }}<template v-if="member.role !== 'owner'"> · {{ MEMBER_STATUS_LABELS[member.status] }}</template></span>
          <span
            v-if="member.displayName && member.email"
            class="muted"
          > · {{ member.email }}</span>
        </span>
        <button
          v-if="manage && member.role !== 'owner' && confirming !== member.id"
          type="button"
          class="danger"
          :disabled="busy"
          :aria-label="`Entfernen: ${nameOf(member)}`"
          :data-remove="member.id"
          @click="ask(member)"
        >
          Entfernen
        </button>
        <span
          v-if="confirming === member.id"
          class="confirm"
          role="group"
          :aria-label="`Entfernen bestätigen: ${nameOf(member)}`"
          :data-confirm="member.id"
        >
          <span>{{ nameOf(member) }} ({{ ROLE_LABELS[member.role] }}) entfernen?</span>
          <button
            type="button"
            class="danger"
            :disabled="busy"
            @click="remove(member)"
          >
            Ja, entfernen
          </button>
          <button
            type="button"
            class="secondary cancel"
            @click="cancel"
          >
            Abbrechen
          </button>
        </span>
      </li>
    </ul>
    <form
      v-if="manage"
      class="card-box"
      @submit.prevent="invite"
    >
      <h3>Einladen</h3>
      <div class="row">
        <div>
          <label :for="ids.email">Schul-E-Mail-Adresse</label>
          <input
            :id="ids.email"
            v-model="email"
            type="email"
            required
            autocomplete="off"
          >
        </div>
        <div>
          <label :for="ids.role">Rolle</label>
          <select
            :id="ids.role"
            v-model="role"
          >
            <option value="witness">
              Zeug:in
            </option>
            <option value="admin">
              Co-Admin
            </option>
          </select>
        </div>
        <button
          type="submit"
          :disabled="busy"
        >
          Einladen
        </button>
      </div>
    </form>
    <output
      v-if="hint"
      class="message ok"
    >
      {{ hint }}
    </output>
    <p
      v-if="error"
      class="message error"
      role="alert"
    >
      {{ error }}
    </p>
  </section>
</template>
