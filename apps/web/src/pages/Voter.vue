<script setup lang="ts">
// The voter page, where a card's QR code and typed address lead. The key
// comes from the fragment (voter/bootstrap.ts, before the router) or is
// typed; the page redeems it once, shows the election and the contests the
// key may vote in, one ballot at a time with a review before it is sent,
// and says when everything is cast. The steps live in this component's
// state, never in the URL; a flag in sessionStorage, never a key, lets a
// reload resume the session. The client of its own (voter/voter-api.ts)
// sends nobody to the sign-in page: a voter's 401 is back to the code.

import { nextTick, onMounted, ref, watch } from 'vue'
import { toSend } from '../voter/ballot-state.ts'
import { pendingKey } from '../voter/bootstrap.ts'
import ContestList from '../voter/ContestList.vue'
import KeyEntry from '../voter/KeyEntry.vue'
import ReviewStep from '../voter/ReviewStep.vue'
import SlotBallot from '../voter/SlotBallot.vue'
import { castBallot, contests, endSession, redeem, VoterError, type VoterBallot, type VoterContest, type VoterElection } from '../voter/voter-api.ts'
import { keyHint, messageFor } from '../voter/voter-rules.ts'

type Step
  = | { kind: 'loading' }
    | { kind: 'code' }
    | { kind: 'list' }
    | { kind: 'ballot', contest: VoterContest, initial?: VoterBallot }
    | { kind: 'review', contest: VoterContest, ballot: VoterBallot }
    | { kind: 'done' }

/** Set from redemption until the session ends, so that a reload resumes it; never a key. */
const FLAG = 'voter'

const root = ref<HTMLElement | null>(null)
const step = ref<Step>({ kind: 'loading' })
const election = ref<VoterElection | null>(null)
const message = ref<string | null>(null)
const busy = ref(false)

function go(next: Step, note: string | null = null): void {
  message.value = note
  step.value = next
}

// A step's heading takes the focus, so that the change is read out and the
// keyboard starts at the top; the code step's field takes it itself.
watch(step, async (now) => {
  if (now.kind === 'code' || now.kind === 'loading') return
  await nextTick()
  root.value?.querySelector<HTMLElement>('h1')?.focus()
})

function flagged(): boolean {
  try {
    return sessionStorage.getItem(FLAG) === '1'
  } catch {
    return false
  }
}

function flag(on: boolean): void {
  try {
    if (on) sessionStorage.setItem(FLAG, '1')
    else sessionStorage.removeItem(FLAG)
  } catch {
    // A browser without storage resumes nothing; voting works all the same.
  }
}

onMounted(async () => {
  const key = pendingKey()
  if (key !== undefined) await redeemKey(key)
  else if (flagged()) await resume()
  else go({ kind: 'code' })
})

/** A code, from the fragment or typed: checked here first, so a malformed one is never sent. */
async function redeemKey(key: string): Promise<void> {
  const hint = keyHint(key)
  if (hint !== null) {
    go({ kind: 'code' }, hint)
    return
  }
  message.value = null
  busy.value = true
  try {
    arrived(await redeem(key))
    flag(true)
  } catch (err) {
    go({ kind: 'code' }, messageFor(err))
  } finally {
    busy.value = false
  }
}

async function resume(): Promise<void> {
  try {
    arrived(await contests())
  } catch (err) {
    flag(false)
    go({ kind: 'code' }, messageFor(err))
  }
}

function arrived(known: VoterElection): void {
  election.value = known
  go({ kind: 'list' })
}

function open(contest: VoterContest): void {
  go({ kind: 'ballot', contest })
}

function toList(): void {
  go({ kind: 'list' })
}

function toReview(ballot: VoterBallot): void {
  if (step.value.kind === 'ballot') go({ kind: 'review', contest: step.value.contest, ballot })
}

function correct(): void {
  if (step.value.kind === 'review') go({ kind: 'ballot', contest: step.value.contest, initial: step.value.ballot })
}

function markDone(contest: VoterContest, remaining?: number): void {
  if (!election.value) return
  const known = election.value.contests.find((entry) => entry.id === contest.id)
  if (known) known.done = true
  election.value.remaining = remaining ?? election.value.contests.filter((entry) => !entry.done).length
}

async function submit(confirmInvalid: boolean): Promise<void> {
  if (step.value.kind !== 'review') return
  const { contest, ballot } = step.value
  message.value = null
  busy.value = true
  try {
    const cast = await castBallot(contest.roundContestId, toSend(ballot, confirmInvalid))
    markDone(contest, cast.remaining)
    if (cast.done) {
      flag(false)
      go({ kind: 'done' })
    } else {
      go({ kind: 'list' })
    }
  } catch (err) {
    if (err instanceof VoterError && err.code === 'already_voted') {
      markDone(contest)
      go({ kind: 'list' }, messageFor(err))
    } else if (err instanceof VoterError && err.code === 'no_session') {
      flag(false)
      election.value = null
      go({ kind: 'code' }, messageFor(err))
    } else {
      message.value = messageFor(err)
    }
  } finally {
    busy.value = false
  }
}

/** The way out, for a second person at the same phone: the session ends on the server and the page forgets everything. */
async function end(): Promise<void> {
  busy.value = true
  try {
    await endSession()
  } catch {
    // The page forgets the session either way; the cookie is worthless once the round moves on, and short-lived anyway.
  } finally {
    busy.value = false
  }
  flag(false)
  election.value = null
  go({ kind: 'code' })
}
</script>

<template>
  <main
    ref="root"
    class="voter"
  >
    <p
      v-if="step.kind === 'loading'"
      class="muted"
      role="status"
    >
      Einen Moment …
    </p>
    <KeyEntry
      v-else-if="step.kind === 'code'"
      :message="message"
      :busy="busy"
      @submit="redeemKey"
    />
    <ContestList
      v-else-if="step.kind === 'list' && election"
      :election="election"
      :message="message"
      :busy="busy"
      @open="open"
      @end="end"
    />
    <SlotBallot
      v-else-if="step.kind === 'ballot'"
      :key="step.contest.id"
      :contest="step.contest"
      :initial="step.initial"
      @review="toReview"
      @back="toList"
    />
    <ReviewStep
      v-else-if="step.kind === 'review'"
      :contest="step.contest"
      :ballot="step.ballot"
      :busy="busy"
      :message="message"
      @submit="submit"
      @correct="correct"
    />
    <section
      v-else-if="step.kind === 'done'"
      aria-labelledby="voter-heading"
    >
      <h1
        id="voter-heading"
        tabindex="-1"
      >
        Danke!
      </h1>
      <p>Ihre Stimme ist abgegeben. Sie können diese Seite jetzt schließen.</p>
    </section>
  </main>
</template>

<style scoped>
.voter {
  max-width: 36rem;
  margin: 0 auto;
  padding: 16px;
}

.voter :deep(h1:focus) {
  outline: none;
}

.voter :deep(h1:focus-visible) {
  outline: 2px solid var(--accent);
  outline-offset: 4px;
}

.voter :deep(button) {
  min-height: 44px;
}
</style>
