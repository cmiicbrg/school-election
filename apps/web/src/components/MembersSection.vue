<script setup lang="ts">
// Mitglieder: co-admins and witnesses, pending or bound, invited by their
// school e-mail address. An invitation takes effect at the invited
// person's next sign-in, which the page says after inviting; no e-mail
// is sent, so the form names the app's address to pass on. The owner
// invites and removes both roles, a co-admin witnesses only, until the
// result is final. The owner can hand the Wahlleitung to a co-admin who
// has signed in, and becomes a co-admin. Removing a member and handing
// over the lead ask first, in place, and a toast confirms each. Each
// member is a row with their initials, their role as a badge, and
// "(Sie)" beside the caller.

import { computed, nextTick, ref, useId, watch } from 'vue'
import LineIcon from './LineIcon.vue'
import { apiDelete, apiPost } from '../lib/api.ts'
import { errorMessage } from '../lib/api-rules.ts'
import { BASE_URL } from '../lib/base.ts'
import { MEMBER_STATUS_LABELS, ROLE_DESCRIPTIONS, ROLE_LABELS, type Role } from '../lib/labels.ts'
import { initials, ownMember } from '../lib/people.ts'
import { session } from '../lib/session.ts'
import { notify } from '../lib/toast.ts'
import type { Member } from '../lib/types.ts'

const props = defineProps<{
  electionId: string
  members: Member[]
  /** The caller's role in the termin. */
  callerRole: Role
  /** The caller may invite and remove witnesses now. */
  witnesses: boolean
  /** The caller may invite and remove co-admins now. */
  coAdmins: boolean
  /** The caller may hand the Wahlleitung to a co-admin now. */
  lead: boolean
  /** The result is final: members no longer change. */
  final: boolean
}>()

const emit = defineEmits<{ changed: [] }>()

const ids = { form: useId(), email: useId(), role: useId(), roleText: useId() }
const email = ref('')
const role = ref<'admin' | 'witness'>('witness')
const busy = ref(false)
const error = ref<string | null>(null)
const hint = ref<string | null>(null)
/** A question that waits for its confirmation: removing a member, or handing them the lead. */
interface Question { kind: 'remove' | 'lead', id: string }
const confirming = ref<Question | null>(null)
const asked = (member: Member, kind: Question['kind']): boolean => confirming.value?.kind === kind && confirming.value.id === member.id
const keyOf = (question: Question): string => `${question.kind}:${question.id}`
/** Where invited people sign in. */
const address = `${BASE_URL}/`
// Without co-admins to manage, after handing over the lead, the form
// offers witnesses only, and invites one.
watch(() => props.coAdmins, (coAdmins) => {
  if (!coAdmins) role.value = 'witness'
})
/** The caller's own row, marked "(Sie)". */
const own = computed(() => (session.value ? ownMember(props.members, props.callerRole, session.value.displayName) : undefined))

/** Under a member's name: whether they have signed in, and the address they were invited by. */
function details(member: Member): string {
  return [
    member.role === 'owner' ? '' : MEMBER_STATUS_LABELS[member.status],
    member.displayName ? (member.email ?? '') : '',
  ].filter((part) => part !== '').join(' · ')
}

/** Inviting a second co-admin: one is usually enough. */
const anotherCoAdmin = computed(() => role.value === 'admin' && props.members.some((member) => member.role === 'admin'))

function mayRemove(member: Member): boolean {
  if (member.role === 'admin') return props.coAdmins
  return member.role === 'witness' && props.witnesses
}

/** The lead goes to a co-admin who has signed in. */
function mayLead(member: Member): boolean {
  return props.lead && member.role === 'admin' && member.status === 'bound'
}

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

async function ask(kind: Question['kind'], member: Member): Promise<void> {
  const question = { kind, id: member.id }
  confirming.value = question
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-confirm="${CSS.escape(keyOf(question))}"] .cancel`)?.focus()
}
async function cancel(): Promise<void> {
  const question = confirming.value
  confirming.value = null
  if (question === null) return
  await nextTick()
  document.querySelector<HTMLButtonElement>(`[data-ask="${CSS.escape(keyOf(question))}"]`)?.focus()
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

async function handOver(member: Member): Promise<void> {
  confirming.value = null
  busy.value = true
  error.value = null
  hint.value = null
  try {
    await apiPost(`/api/elections/${props.electionId}/lead`, { memberId: member.id })
    notify(`Wahlleitung an ${nameOf(member)} übergeben. Sie sind jetzt Co-Admin.`)
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
  <div class="members">
    <ul
      class="people"
      aria-label="Mitglieder"
    >
      <li
        v-for="member in members"
        :key="member.id"
      >
        <span
          class="initials"
          :class="{ lead: member.role === 'owner' }"
          aria-hidden="true"
        >{{ initials(nameOf(member)) }}</span>
        <span class="person">
          <span class="name">{{ nameOf(member) }}<span
            v-if="own?.id === member.id"
            class="muted"
          > (Sie)</span></span>
          <span
            v-if="details(member)"
            class="details muted"
          >{{ details(member) }}</span>
        </span>
        <span :class="['badge', { info: member.role === 'owner' }]">{{ ROLE_LABELS[member.role] }}</span>
        <span
          v-if="(mayLead(member) && !asked(member, 'lead')) || (mayRemove(member) && !asked(member, 'remove'))"
          class="row-actions"
        >
          <button
            v-if="mayLead(member) && !asked(member, 'lead')"
            type="button"
            class="secondary small"
            :disabled="busy"
            :aria-label="`Wahlleitung übergeben: ${nameOf(member)}`"
            :data-ask="`lead:${member.id}`"
            @click="ask('lead', member)"
          >
            Wahlleitung übergeben
          </button>
          <button
            v-if="mayRemove(member) && !asked(member, 'remove')"
            type="button"
            class="ghost danger small"
            :disabled="busy"
            :aria-label="`Entfernen: ${nameOf(member)}`"
            :data-ask="`remove:${member.id}`"
            @click="ask('remove', member)"
          >
            <LineIcon name="trash" />Entfernen
          </button>
        </span>
        <fieldset
          v-if="mayLead(member) && asked(member, 'lead')"
          class="confirm"
          :aria-label="`Übergabe bestätigen: ${nameOf(member)}`"
          :data-confirm="`lead:${member.id}`"
        >
          <span>Wahlleitung an {{ nameOf(member) }} übergeben? Sie werden Co-Admin; das Ergebnis feststellen, den Wahltermin löschen und Co-Admins verwalten kann dann nur noch {{ nameOf(member) }}.</span>
          <button
            type="button"
            :disabled="busy"
            @click="handOver(member)"
          >
            Ja, übergeben
          </button>
          <button
            type="button"
            class="secondary cancel"
            @click="cancel"
          >
            Abbrechen
          </button>
        </fieldset>
        <fieldset
          v-if="mayRemove(member) && asked(member, 'remove')"
          class="confirm"
          :aria-label="`Entfernen bestätigen: ${nameOf(member)}`"
          :data-confirm="`remove:${member.id}`"
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
        </fieldset>
      </li>
    </ul>
    <p
      v-if="final"
      class="muted"
    >
      Das Ergebnis ist festgestellt; Mitglieder ändern sich nicht mehr.
    </p>
    <form
      v-else-if="witnesses"
      class="invite"
      :aria-labelledby="ids.form"
      @submit.prevent="invite"
    >
      <h3 :id="ids.form">
        Einladen
      </h3>
      <div class="invite-row">
        <div class="email">
          <label :for="ids.email">Schul-E-Mail-Adresse</label>
          <input
            :id="ids.email"
            v-model="email"
            type="email"
            required
            autocomplete="off"
          >
        </div>
        <div class="role">
          <label :for="ids.role">Rolle</label>
          <select
            :id="ids.role"
            v-model="role"
            :aria-describedby="ids.roleText"
          >
            <option value="witness">
              {{ ROLE_LABELS.witness }}
            </option>
            <option
              v-if="coAdmins"
              value="admin"
            >
              {{ ROLE_LABELS.admin }}
            </option>
          </select>
        </div>
        <button
          type="submit"
          :disabled="busy"
        >
          <LineIcon name="user-plus" />Einladen
        </button>
      </div>
      <p
        :id="ids.roleText"
        class="role-text"
      >
        {{ ROLE_DESCRIPTIONS[role] }}
        <template v-if="anotherCoAdmin">
          Meist genügt eine Person als Co-Admin; dieser Wahltermin hat schon eine.
        </template>
      </p>
      <p class="note">
        <LineIcon name="info" />
        <span>
          Mitglieder können bis zur Feststellung des Ergebnisses eingeladen und entfernt werden.
          Es wird keine E-Mail verschickt: Teilen Sie der eingeladenen Person die Adresse <code>{{ address }}</code> selbst mit.
        </span>
      </p>
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
  </div>
</template>

<style scoped>
.members {
  display: flex;
  flex-direction: column;
  gap: 24px;
}

.members > p,
.members > output {
  margin: 0;
}

.people {
  margin: 0;
  padding: 0;
  border: 1px solid var(--line);
  border-radius: 12px;
  list-style: none;
}

.people > li {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 12px;
  padding: 12px 16px;
}

.people > li + li {
  border-top: 1px solid var(--line);
}

.people .initials {
  width: 36px;
  height: 36px;
  border: 0;
  background: var(--chip);
  font-size: 0.75rem;
}

.people .initials.lead {
  background: var(--info-bg);
  color: var(--accent);
}

.person {
  flex: 1 1 200px;
  display: flex;
  flex-direction: column;
  min-width: 0;
}

.name {
  font-weight: 600;
  overflow-wrap: anywhere;
}

.name .muted {
  font-weight: 400;
}

.details {
  font-size: 0.8rem;
  overflow-wrap: anywhere;
}

.row-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}

.people .confirm {
  flex: 1 1 100%;
  margin: 0;
}

.invite {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.invite h3 {
  margin: 0;
}

.invite-row {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 12px;
}

.email {
  flex: 2 1 260px;
}

.role {
  flex: 1 1 160px;
}

.role-text {
  margin: 0;
  color: var(--ink2);
  font-size: 0.85rem;
}

code {
  overflow-wrap: anywhere;
}
</style>
